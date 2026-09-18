// mahas-runtime/artifacts — default filesystem/git backing for MailIo.
//
// Real implementations used when MailDeps.io is not injected. Kept tiny and
// honest: a missing file or a missing git object reports null/throws — the
// publisher turns those into ARTIFACT_MISMATCH, never a fabricated digest.

import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import type { MailIo } from '../mail/api.ts'

function git(repoPath: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, ...args], { timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(stdout.trim())
    })
  })
}

export const defaultMailIo: MailIo = {
  async readFileBytes(absolutePath: string): Promise<Uint8Array> {
    const buf = await readFile(absolutePath)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  },

  async gitResolveCommit(
    repoPath: string,
    commit: string
  ): Promise<{ sha: string; bytes: number } | null> {
    // never let a commit-ish be parsed as a flag
    if (!commit || commit.startsWith('-') || /[\s]/.test(commit)) return null
    const sha = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return null
    const size = await git(repoPath, ['cat-file', '-s', sha])
    const bytes = size === null ? 0 : Number.parseInt(size, 10)
    if (!Number.isFinite(bytes) || bytes < 0) return null
    return { sha: sha.toLowerCase(), bytes }
  }
}
