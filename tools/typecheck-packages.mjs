#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, extname, join, resolve } from 'node:path'
import ts from 'typescript'
import { REPO_ROOT, discoverPackages } from './boundary-policy.mjs'

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts']

function stringsIn(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

function declaredEntrypoints(pkg) {
  const values = [
    pkg.manifest.main,
    pkg.manifest.module,
    pkg.manifest.types,
    pkg.manifest.typings,
    ...stringsIn(pkg.manifest.bin),
    ...stringsIn(pkg.manifest.exports)
  ].filter((value) => typeof value === 'string' && value.startsWith('./'))
  return [...new Set(values)].sort()
}

function sourceForEntrypoint(pkg, entrypoint) {
  const direct = resolve(pkg.root, entrypoint)
  if (existsSync(direct)) return direct
  const ext = extname(direct)
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const stem = direct.slice(0, -ext.length)
    for (const sourceExtension of sourceExtensions) {
      if (existsSync(`${stem}${sourceExtension}`)) return `${stem}${sourceExtension}`
    }
  }
  return null
}

function parsedConfig(configPath) {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, ts.sys)
  if (!parsed) throw new Error(`could not parse ${configPath}`)
  if (parsed.errors.length > 0) {
    const message = ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => REPO_ROOT,
      getNewLine: () => '\n'
    })
    throw new Error(message)
  }
  return new Set(parsed.fileNames.map((file) => resolve(file)))
}

/** Every source file the package owns, so nothing is silently unchecked. */
function packageSourceFiles(pkg) {
  const src = join(pkg.root, 'src')
  if (!existsSync(src)) return []
  return ts.sys
    .readDirectory(src, sourceExtensions, undefined, ['**/*'])
    .map((file) => resolve(file))
    .sort()
}

function inspectPackage(pkg) {
  const configPath = join(pkg.root, 'tsconfig.json')
  if (!existsSync(configPath)) {
    return { pkg, configPath, entrypoints: [], programFiles: [], problems: ['missing tsconfig.json'] }
  }
  const compiledFiles = parsedConfig(configPath)
  const entrypoints = declaredEntrypoints(pkg)
  const problems = []
  for (const entrypoint of entrypoints) {
    const source = sourceForEntrypoint(pkg, entrypoint)
    if (!source) problems.push(`declared entrypoint does not exist: ${entrypoint}`)
    else if (!compiledFiles.has(source)) problems.push(`tsconfig does not typecheck declared entrypoint: ${entrypoint}`)
  }
  for (const source of packageSourceFiles(pkg)) {
    if (!compiledFiles.has(source)) {
      problems.push(`tsconfig does not typecheck package source: ${basename(source)}`)
    }
  }
  return { pkg, configPath, entrypoints, programFiles: [...compiledFiles], problems }
}

function runTypecheck(configPath) {
  const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', configPath], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  })
  return result.status === 0
}

function run() {
  const listOnly = process.argv.includes('--list')
  const packages = discoverPackages(REPO_ROOT)
  let failed = 0
  let checkedFiles = 0
  for (const pkg of packages) {
    const inspected = inspectPackage(pkg)
    checkedFiles += inspected.programFiles.length
    const entries = inspected.entrypoints.length > 0 ? inspected.entrypoints.join(', ') : '(no declared entrypoint)'
    process.stdout.write(`${pkg.name}: ${entries}\n`)
    if (inspected.problems.length > 0) {
      failed++
      for (const problem of inspected.problems) {
        process.stderr.write(`${pkg.name}: ${problem}\n`)
      }
      continue
    }
    if (!listOnly && !runTypecheck(inspected.configPath)) failed++
  }
  if (failed > 0) {
    process.stderr.write(`package typecheck failed (${failed} package(s))\n`)
    process.exitCode = 1
    return
  }
  const verb = listOnly ? 'inspected' : 'typechecked'
  process.stdout.write(`${verb} ${packages.length} package(s), ${checkedFiles} program file(s)\n`)
}

run()

