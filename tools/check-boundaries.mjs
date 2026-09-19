#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import {
  REPO_ROOT,
  discoverPackages,
  formatBoundaryIssue,
  specifiersAreTypeOnly,
  validateImport
} from './boundary-policy.mjs'

const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts'])

function importClauseIsTypeOnly(clause) {
  if (!clause) return false
  if (clause.isTypeOnly) return true
  const bindings = clause.namedBindings
  return bindings !== undefined && ts.isNamedImports(bindings)
    ? specifiersAreTypeOnly(bindings.elements)
    : false
}

function exportDeclarationIsTypeOnly(node) {
  if (node.isTypeOnly) return true
  return node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
    ? specifiersAreTypeOnly(node.exportClause.elements)
    : false
}

function collectSourceFiles(directory) {
  const files = []
  const visit = (current) => {
    for (const entry of ts.sys.readDirectory(current, [...sourceExtensions], undefined, ['**/*'])) {
      files.push(resolve(entry))
    }
  }
  visit(directory)
  return [...new Set(files)].sort()
}

function literalText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null
}

/** Extract imports from TypeScript syntax without relying on a regex. */
export function importsInFile(filename) {
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const imports = []
  const add = (node, moduleSpecifier, typeOnly) => {
    const specifier = literalText(moduleSpecifier)
    if (specifier === null) return
    const start = source.getLineAndCharacterOfPosition(moduleSpecifier.getStart(source))
    imports.push({ specifier, typeOnly, line: start.line + 1, column: start.character + 1 })
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      add(node, node.moduleSpecifier, importClauseIsTypeOnly(node.importClause))
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node, node.moduleSpecifier, exportDeclarationIsTypeOnly(node))
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression
      if (expression) add(node, expression, false)
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && argument) add(node, argument, false)
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      if (ts.isLiteralTypeNode(argument)) add(node, argument.literal, true)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return imports
}

function packageSourceFiles(root, packages) {
  return packages.flatMap((pkg) => collectSourceFiles(join(pkg.root, 'src')))
}

function desktopSourceFiles(root) {
  return ['main', 'preload', 'renderer'].flatMap((surface) => collectSourceFiles(join(root, 'src', surface)))
}

export function checkProject(root = REPO_ROOT) {
  const packages = discoverPackages(root)
  const diagnostics = []
  const files = [...packageSourceFiles(root, packages), ...desktopSourceFiles(root)].sort()
  for (const filename of files) {
    for (const imported of importsInFile(filename)) {
      const boundaryIssue = validateImport({
        root,
        packages,
        filename,
        specifier: imported.specifier,
        typeOnly: imported.typeOnly
      })
      if (boundaryIssue) diagnostics.push({ filename, ...imported, issue: boundaryIssue })
    }
  }
  return { packages, files, diagnostics }
}

function writeFixture(root, path, contents) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

function fixtureManifest(name, dependencies = {}) {
  return JSON.stringify({ name, private: true, type: 'module', dependencies }, null, 2)
}

function runSelfTest() {
  const root = mkdtempSync(join(tmpdir(), 'mahas-boundaries-'))
  try {
    const packages = [
      ['mahas-contracts', {}],
      ['mahas-harness-config', { 'mahas-contracts': '*' }],
      ['mahas-execution-host', { 'mahas-contracts': '*' }],
      ['mahas-runtime', { 'mahas-contracts': '*', 'mahas-harness-config': '*', 'mahas-client': '*' }],
      ['mahas-client', { 'mahas-contracts': '*' }],
      [
        'mahas-cli',
        {
          'mahas-contracts': '*',
          'mahas-client': '*',
          'mahas-harness-config': '*',
          'mahas-runtime': '*'
        }
      ]
    ]
    for (const [name, dependencies] of packages) {
      writeFixture(root, `packages/${name}/package.json`, fixtureManifest(name, dependencies))
      writeFixture(root, `packages/${name}/src/index.ts`, 'export {}\n')
    }

    writeFixture(root, 'packages/mahas-contracts/src/node.ts', "import 'node:fs'\n")
    writeFixture(
      root,
      'packages/mahas-contracts/src/deep/nested.ts',
      "import type {} from '../../../mahas-runtime/src/index.ts'\n"
    )
    writeFixture(
      root,
      'packages/mahas-harness-config/src/a/b/deep.ts',
      "import type {} from '../../../../mahas-runtime/src/index.ts'\n"
    )
    writeFixture(
      root,
      'packages/mahas-harness-config/src/desktop.ts',
      "import type {} from '../../../src/main/index.ts'\n"
    )
    writeFixture(
      root,
      'packages/mahas-runtime/src/production.ts',
      "import {} from '../../mahas-execution-host/src/index.ts'\n"
    )
    writeFixture(
      root,
      'packages/mahas-runtime/src/host.smoke.ts',
      "import {} from '../../mahas-execution-host/src/index.ts'\n"
    )
    writeFixture(
      root,
      'packages/mahas-runtime/src/rpc/client.ts',
      "import {} from '../../../mahas-client/src/index.ts'\n"
    )
    writeFixture(
      root,
      'packages/mahas-runtime/src/not-a-facade.ts',
      "import {} from '../../mahas-client/src/index.ts'\n"
    )
    writeFixture(
      root,
      'packages/mahas-runtime/src/client.smoke.ts',
      "import {} from '../../mahas-client/src/index.ts'\n"
    )
    writeFixture(
      root,
      'packages/mahas-client/src/bad-reverse.ts',
      "import {} from '../../mahas-runtime/src/index.ts'\n"
    )
    writeFixture(
      root,
      'src/renderer/src/contracts.ts',
      "import type {} from '../../../packages/mahas-contracts/src/index.ts'\n"
    )
    writeFixture(
      root,
      'src/renderer/src/value-contract.ts',
      "import {} from '../../../packages/mahas-contracts/src/index.ts'\n"
    )
    writeFixture(
      root,
      'src/renderer/src/inline-type-contract.ts',
      "import { type ControlResult } from '../../../packages/mahas-contracts/src/index.ts'\n"
    )
    writeFixture(
      root,
      'src/renderer/src/inline-mixed-contract.ts',
      "import { type ControlResult, unavailableClient } from '../../../packages/mahas-contracts/src/index.ts'\n"
    )
    writeFixture(
      root,
      'src/renderer/src/inline-type-reexport.ts',
      "export { type ControlResult } from '../../../packages/mahas-contracts/src/index.ts'\n"
    )
    writeFixture(
      root,
      'src/renderer/src/value-reexport.ts',
      "export { unavailableClient } from '../../../packages/mahas-contracts/src/index.ts'\n"
    )
    writeFixture(
      root,
      'src/preload/client.ts',
      "import type {} from '../../packages/mahas-client/src/index.ts'\n"
    )

    const result = checkProject(root)
    const codesByFile = new Map()
    for (const diagnostic of result.diagnostics) {
      const key = relative(root, diagnostic.filename).split(sep).join('/')
      const codes = codesByFile.get(key) ?? new Set()
      codes.add(diagnostic.issue.code)
      codesByFile.set(key, codes)
    }
    const expects = [
      ['rejects Node imports from contracts', 'packages/mahas-contracts/src/node.ts', 'CONTRACTS_NODE'],
      [
        'rejects nested relative contracts-to-runtime imports',
        'packages/mahas-contracts/src/deep/nested.ts',
        'CONTRACTS_SIBLING'
      ],
      [
        'rejects nested relative harness-to-runtime imports',
        'packages/mahas-harness-config/src/a/b/deep.ts',
        'PACKAGE_DIRECTION'
      ],
      [
        'rejects package-to-desktop imports',
        'packages/mahas-harness-config/src/desktop.ts',
        'PACKAGE_TO_DESKTOP'
      ],
      [
        'rejects production runtime-to-host imports',
        'packages/mahas-runtime/src/production.ts',
        'RUNTIME_HOST_TEST_ONLY'
      ],
      [
        'allows integration runtime-to-host smoke imports',
        'packages/mahas-runtime/src/host.smoke.ts',
        null
      ],
      [
        'allows the narrow runtime RPC compatibility facade',
        'packages/mahas-runtime/src/rpc/client.ts',
        null
      ],
      [
        'rejects runtime-to-client imports outside the facade',
        'packages/mahas-runtime/src/not-a-facade.ts',
        'PACKAGE_DIRECTION'
      ],
      [
        'allows a runtime smoke to drive the real client',
        'packages/mahas-runtime/src/client.smoke.ts',
        null
      ],
      [
        'rejects client-to-runtime reverse imports',
        'packages/mahas-client/src/bad-reverse.ts',
        'PACKAGE_DIRECTION'
      ],
      [
        'allows renderer type-only contracts',
        'src/renderer/src/contracts.ts',
        null
      ],
      [
        'rejects renderer value contracts',
        'src/renderer/src/value-contract.ts',
        'UI_CONTRACT_TYPE_ONLY'
      ],
      [
        'allows renderer inline type imports',
        'src/renderer/src/inline-type-contract.ts',
        null
      ],
      [
        'rejects mixed inline import specifiers',
        'src/renderer/src/inline-mixed-contract.ts',
        'UI_CONTRACT_TYPE_ONLY'
      ],
      [
        'allows renderer inline type re-exports',
        'src/renderer/src/inline-type-reexport.ts',
        null
      ],
      [
        'rejects renderer value re-exports',
        'src/renderer/src/value-reexport.ts',
        'UI_CONTRACT_TYPE_ONLY'
      ],
      [
        'rejects preload-to-client imports',
        'src/preload/client.ts',
        'UI_PACKAGE_DIRECTION'
      ]
    ]
    let failed = 0
    for (const [label, filename, expectedCode] of expects) {
      const actual = codesByFile.get(filename) ?? new Set()
      const passed = expectedCode === null ? actual.size === 0 : actual.has(expectedCode)
      process.stdout.write(`${passed ? '✓' : '✗'} ${label}\n`)
      if (!passed) {
        failed++
        process.stderr.write(
          `  expected ${expectedCode ?? 'no diagnostics'} for ${filename}; got ${[...actual].join(', ') || 'none'}\n`
        )
      }
    }
    if (failed > 0) throw new Error(`${failed} boundary fixture expectation(s) failed`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function run() {
  if (process.argv.includes('--self-test')) {
    runSelfTest()
    return
  }
  const rootFlag = process.argv.indexOf('--root')
  const root = rootFlag >= 0 ? resolve(process.argv[rootFlag + 1] ?? REPO_ROOT) : REPO_ROOT
  const result = checkProject(root)
  if (result.diagnostics.length === 0) {
    process.stdout.write(`boundary check passed (${result.packages.length} packages, ${result.files.length} source files)\n`)
    return
  }
  for (const diagnostic of result.diagnostics) {
    process.stderr.write(`${formatBoundaryIssue({ ...diagnostic, root })}:${diagnostic.line}:${diagnostic.column}\n`)
  }
  process.stderr.write(`boundary check failed (${result.diagnostics.length} violation(s))\n`)
  process.exitCode = 1
}

run()
