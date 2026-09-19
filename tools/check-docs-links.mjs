#!/usr/bin/env node
// Checks that every repo-relative Markdown link target exists. The docs tree was
// reorganized into stubs plus new directories, so a stale relative link is the
// cheapest way for the documentation to lie about where something lives.
//
// Scope: root Markdown files, docs/**, packages/**, integrations/**, .codex/**
// (repo skills), and the mahas-architecture README (its task packages keep
// their own historical links).
// Limitations: link *labels* are not checked, reference-style links are ignored,
// and links inside fenced code blocks or inline code are skipped as examples.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { REPO_ROOT } from './boundary-policy.mjs'

const IGNORED_PREFIXES = ['#', 'http://', 'https://', 'mailto:', 'data:', 'file://']

function scanRoots(root) {
  const roots = ['README.md', 'AGENTS.md', 'HANDOFF.md', 'domain-model-design.md', 'domain-model-needs.md', 'milestone-plan.md', 'mahas-architecture/README.md']
  for (const directory of ['docs', 'packages', 'integrations', '.codex']) {
    const target = join(root, directory)
    if (existsSync(target)) roots.push(...ts.sys.readDirectory(target, ['.md'], undefined, ['**/*']))
  }
  return [...new Set(roots.map((entry) => resolve(root, entry)))].filter((file) => existsSync(file)).sort()
}

/** Strip fenced blocks and inline code so example links are not resolved. */
function linkBearingLines(text) {
  const lines = []
  let fence = null
  for (const [index, raw] of text.split('\n').entries()) {
    const trimmed = raw.trimStart()
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fence !== null) {
      if (fenceMatch !== null && trimmed.startsWith(fence)) fence = null
      continue
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1][0].repeat(3)
      continue
    }
    lines.push({ line: index + 1, text: raw.replace(/`[^`]*`/g, '') })
  }
  return lines
}

function linksInFile(filename) {
  const found = []
  for (const { line, text } of linkBearingLines(readFileSync(filename, 'utf8'))) {
    const pattern = /\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g
    let match
    while ((match = pattern.exec(text)) !== null) {
      const target = match[1]
      if (IGNORED_PREFIXES.some((prefix) => target.startsWith(prefix))) continue
      found.push({ line, target })
    }
  }
  return found
}

export function checkDocsLinks(root = REPO_ROOT) {
  const diagnostics = []
  let checked = 0
  for (const filename of scanRoots(root)) {
    for (const { line, target } of linksInFile(filename)) {
      checked++
      const cleaned = decodeURIComponent(target.split('#')[0].split('?')[0])
      if (cleaned === '') continue
      const resolved = cleaned.startsWith('/')
        ? resolve(root, cleaned.slice(1))
        : resolve(dirname(filename), cleaned)
      if (!existsSync(resolved)) {
        diagnostics.push({ filename, line, target, resolved })
      }
    }
  }
  return { checked, diagnostics }
}

function run() {
  const rootFlag = process.argv.indexOf('--root')
  const root = rootFlag >= 0 ? resolve(process.argv[rootFlag + 1] ?? REPO_ROOT) : REPO_ROOT
  const { checked, diagnostics } = checkDocsLinks(root)
  if (diagnostics.length === 0) {
    process.stdout.write(`docs link check passed (${checked} relative link(s))\n`)
    return
  }
  for (const diagnostic of diagnostics) {
    const file = relative(root, diagnostic.filename).split(sep).join('/')
    const target = relative(root, diagnostic.resolved).split(sep).join('/')
    process.stderr.write(`${file}:${diagnostic.line}: missing target ${target} (from ${diagnostic.target})\n`)
  }
  process.stderr.write(`docs link check failed (${diagnostics.length} broken link(s))\n`)
  process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) run()
