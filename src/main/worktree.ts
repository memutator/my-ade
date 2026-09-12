import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { basename, dirname, join, resolve } from 'path'
import { existsSync } from 'fs'

// git worktree support: each workspace can be fanned out into its own worktree
// (a branch checked out at a separate path) so agents work in isolation.
// New worktrees live in a sibling dir — `<parent>/<repo>.worktrees/<slug>` —
// never inside the repo itself (an in-repo dir would show up as untracked in
// `git status` of the main checkout).

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024
  })
  return stdout
}

async function isRepo(path: string): Promise<boolean> {
  try {
    await git(path, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

interface WorktreeEntry {
  path: string
  branch: string | null
  head: string
  main: boolean
}

// `git worktree list --porcelain` → blank-line-separated blocks:
//   worktree <path>\n  HEAD <sha>\n  branch refs/heads/<name> | detached | bare
function parseWorktrees(out: string, repoPath: string): WorktreeEntry[] {
  const list: WorktreeEntry[] = []
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean)
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9)
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? ''
    const branchRef = lines.find((l) => l.startsWith('branch '))?.slice(7)
    if (!path) continue
    list.push({
      path,
      head,
      branch: branchRef?.startsWith('refs/heads/') ? branchRef.slice(11) : (branchRef ?? null),
      main: resolve(path) === resolve(repoPath)
    })
  }
  return list
}

// dir-safe slug: feat/foo → feat-foo
function slugify(branch: string): string {
  return branch
    .trim()
    .replace(/[/\\\s]+/g, '-')
    .replace(/[^\w.-]/g, '')
}

function wtRoot(repoPath: string): string {
  const abs = resolve(repoPath)
  return join(dirname(abs), `${basename(abs)}.worktrees`)
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export function registerWorktreeIpc(): void {
  ipcMain.handle('git:info', async (_e, repoPath: string) => {
    try {
      if (typeof repoPath !== 'string' || !(await isRepo(repoPath))) return { isRepo: false }
      const [branchOut, branchesOut, wtOut] = await Promise.all([
        git(repoPath, ['branch', '--show-current']).catch(() => ''),
        git(repoPath, ['branch', '--format=%(refname:short)']).catch(() => ''),
        git(repoPath, ['worktree', 'list', '--porcelain']).catch(() => '')
      ])
      return {
        isRepo: true,
        branch: branchOut.trim() || null,
        branches: branchesOut
          .split('\n')
          .map((b) => b.trim())
          .filter(Boolean),
        worktrees: parseWorktrees(wtOut, repoPath),
        wtRoot: wtRoot(repoPath)
      }
    } catch {
      return { isRepo: false }
    }
  })

  ipcMain.handle(
    'git:worktreeAdd',
    async (_e, repoPath: string, opts: { branch?: string; base?: string }) => {
      try {
        const branch = opts?.branch?.trim() ?? ''
        if (!branch) return { ok: false, error: 'branch name required' }
        try {
          await git(repoPath, ['check-ref-format', '--branch', branch])
        } catch {
          return { ok: false, error: `"${branch}" is not a valid branch name` }
        }
        const slug = slugify(branch) || 'worktree'
        const root = wtRoot(repoPath)
        let dest = join(root, slug)
        for (let i = 2; existsSync(dest); i++) dest = join(root, `${slug}-${i}`)
        if (await branchExists(repoPath, branch)) {
          // existing branch: check it out directly (fails if it's already
          // checked out in another worktree — git's message is clear enough)
          await git(repoPath, ['worktree', 'add', dest, branch])
        } else {
          await git(repoPath, ['worktree', 'add', '-b', branch, dest, opts?.base?.trim() || 'HEAD'])
        }
        return { ok: true, path: dest, branch }
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) }
      }
    }
  )

  ipcMain.handle(
    'git:worktreeRemove',
    async (_e, repoPath: string, wtPath: string, force?: boolean) => {
      try {
        if (typeof wtPath !== 'string' || !wtPath) return { ok: false, error: 'invalid path' }
        await git(repoPath, ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath])
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) }
      }
    }
  )
}
