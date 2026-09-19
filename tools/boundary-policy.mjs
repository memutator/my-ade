import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const builtinNames = new Set(
  builtinModules.map((name) => (name.startsWith('node:') ? name.slice('node:'.length) : name))
)

const explicitPackageDependencies = {
  'mahas-contracts': new Set(),
  'mahas-harness-config': new Set(['mahas-contracts']),
  'mahas-execution-host': new Set(['mahas-contracts']),
  'mahas-runtime': new Set(['mahas-contracts', 'mahas-harness-config']),
  'mahas-client': new Set(['mahas-contracts']),
  'mahas-cli': new Set(['mahas-contracts', 'mahas-client', 'mahas-harness-config', 'mahas-runtime'])
}

const desktopMainDependencies = new Set([
  'mahas-contracts',
  'mahas-harness-config',
  'mahas-runtime',
  'mahas-client'
])

const runtimeClientCompatibilityFacades = new Set(['src/bootstrap.ts', 'src/rpc/client.ts'])

function isInside(file, directory) {
  const path = relative(directory, file)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Find package manifests at any depth below packages/, without workspaces. */
export function discoverPackages(root = REPO_ROOT) {
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) return []

  const found = []
  const visit = (directory) => {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath)
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new Error(`${manifestPath} must declare a package name`)
      }
      found.push({ name: manifest.name, root: directory, manifest, manifestPath })
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      visit(join(directory, entry.name))
    }
  }

  visit(packagesDir)
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

export function packageForFile(filename, packages) {
  const absolute = resolve(filename)
  return packages
    .filter((pkg) => isInside(absolute, pkg.root))
    .sort((left, right) => right.root.length - left.root.length)[0]
}

export function desktopSurfaceForFile(filename, root = REPO_ROOT) {
  const absolute = resolve(filename)
  if (isInside(absolute, join(root, 'src', 'main'))) return 'main'
  if (isInside(absolute, join(root, 'src', 'preload'))) return 'preload'
  if (isInside(absolute, join(root, 'src', 'renderer'))) return 'renderer'
  return null
}

function isNodeBuiltin(specifier) {
  const unprefixed = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  return builtinNames.has(unprefixed)
}

function packageForSpecifier(specifier, packages) {
  return packages
    .filter((pkg) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`))
    .sort((left, right) => right.name.length - left.name.length)[0]
}

export function resolveImportTarget({ root = REPO_ROOT, packages, filename, specifier }) {
  if (isNodeBuiltin(specifier)) return { kind: 'node' }

  if (specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier)) {
    const targetPath = isAbsolute(specifier)
      ? resolve(specifier)
      : resolve(dirname(resolve(filename)), specifier)
    const targetPackage = packageForFile(targetPath, packages)
    if (targetPackage) return { kind: 'package', package: targetPackage, path: targetPath }
    const desktop = desktopSurfaceForFile(targetPath, root)
    if (desktop) return { kind: 'desktop', surface: desktop, path: targetPath }
    return { kind: 'other', path: targetPath }
  }

  const targetPackage = packageForSpecifier(specifier, packages)
  if (targetPackage) return { kind: 'package', package: targetPackage }
  if (specifier === '@renderer' || specifier.startsWith('@renderer/')) {
    return { kind: 'desktop', surface: 'renderer' }
  }
  return { kind: 'external' }
}

function sourceRelativeToPackage(filename, pkg) {
  return relative(pkg.root, resolve(filename)).split(sep).join('/')
}

/**
 * Test-only runtime files: `*.smoke.ts`, `*.manual.ts`, and anything inside a
 * fixture directory. These may reach peer packages the production runtime may
 * not, because they exist to drive a real daemon/client end to end — the
 * production direction rules still apply to every other file.
 */
function isRuntimeTestFixture(filename, runtimePackage) {
  const relativeSource = sourceRelativeToPackage(filename, runtimePackage)
  if (/\.(?:smoke|manual)\.[cm]?[jt]sx?$/.test(relativeSource)) return true
  return relativeSource.split('/').some((part) => ['fixture', 'fixtures', '__fixtures__'].includes(part))
}

function isRuntimeClientCompatibilityFacade(filename, runtimePackage) {
  return runtimeClientCompatibilityFacades.has(sourceRelativeToPackage(filename, runtimePackage))
}

function hasRuntimeDependency(pkg, target) {
  return Object.prototype.hasOwnProperty.call(pkg.manifest.dependencies ?? {}, target.name)
}

function issue(code, message) {
  return { code, message }
}

/**
 * True when every named specifier carries its own `type` marker, e.g.
 * `import { type A, type B } from '...'` or `export { type A } from '...'`.
 * An empty specifier list is NOT type-only (`import {} from '...'` still
 * evaluates the module), and one value specifier makes the whole clause a
 * value import.
 *
 * Typescript's own AST exposes `isTypeOnly` on specifiers; typescript-eslint
 * exposes `importKind`/`exportKind` on the same nodes, so this helper serves
 * both the CLI checker and the ESLint rule from one implementation.
 */
export function specifiersAreTypeOnly(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return false
  return elements.every(
    (element) =>
      element?.isTypeOnly === true ||
      element?.importKind === 'type' ||
      element?.exportKind === 'type'
  )
}

/**
 * Validate one already-resolved import edge. The function deliberately takes
 * a filename and a specifier rather than matching textual ../ depth, so a
 * nested package path cannot evade the direction rules. It returns at most
 * one issue, reporting the dependency *direction* before the declaration of
 * that dependency: a forbidden edge is a boundary violation even when the
 * package manifest also forgot to declare it.
 *
 * Imports inside one package are always allowed: a package may compose its
 * own migration fragments, repositories and services without declaring
 * anything, and no sibling-package rule applies to them.
 */
export function validateImport({
  root = REPO_ROOT,
  packages = discoverPackages(root),
  filename,
  specifier,
  typeOnly = false
}) {
  const sourcePackage = packageForFile(filename, packages)
  const sourceDesktop = sourcePackage ? null : desktopSurfaceForFile(filename, root)
  if (!sourcePackage && !sourceDesktop) return null

  const target = resolveImportTarget({ root, packages, filename, specifier })

  if (sourcePackage) {
    if (target.kind === 'desktop') {
      return issue(
        'PACKAGE_TO_DESKTOP',
        `${sourcePackage.name} may not import desktop src/ (${specifier} resolves to src/${target.surface})`
      )
    }

    if (sourcePackage.name === 'mahas-contracts') {
      if (target.kind === 'node') {
        return issue(
          'CONTRACTS_NODE',
          `mahas-contracts is renderer-safe and may not import Node (${specifier})`
        )
      }
      if (target.kind === 'package' && target.package.name !== sourcePackage.name) {
        return issue(
          'CONTRACTS_SIBLING',
          `mahas-contracts may not depend on sibling package ${target.package.name}`
        )
      }
      if (target.kind === 'external') {
        return issue(
          'CONTRACTS_EXTERNAL',
          `mahas-contracts has no runtime or third-party dependencies (${specifier})`
        )
      }
    }

    if (target.kind !== 'package' || target.package.name === sourcePackage.name) return null

    if (sourcePackage.name === 'mahas-runtime' && target.package.name === 'mahas-execution-host') {
      if (isRuntimeTestFixture(filename, sourcePackage)) return null
      return issue(
        'RUNTIME_HOST_TEST_ONLY',
        'mahas-runtime may import mahas-execution-host only from *.smoke.ts, *.manual.ts, or a fixture directory'
      )
    }

    if (
      sourcePackage.name === 'mahas-runtime' &&
      target.package.name === 'mahas-client'
    ) {
      // Production runtime code reaches the client only through the two
      // compatibility facades; test fixtures may drive the real client.
      if (isRuntimeClientCompatibilityFacade(filename, sourcePackage)) return null
      if (isRuntimeTestFixture(filename, sourcePackage)) return null
    }

    const allowed = explicitPackageDependencies[sourcePackage.name]
    if (allowed && !allowed.has(target.package.name)) {
      const compatibilityHint =
        sourcePackage.name === 'mahas-runtime' && target.package.name === 'mahas-client'
          ? ' Only src/bootstrap.ts and src/rpc/client.ts may do this while they remain compatibility facades; remove this allowance when those facades are deleted.'
          : ''
      return issue(
        'PACKAGE_DIRECTION',
        `${sourcePackage.name} may not import ${target.package.name}.${compatibilityHint}`
      )
    }

    if (!hasRuntimeDependency(sourcePackage, target.package)) {
      return issue(
        'UNDECLARED_PACKAGE_DEPENDENCY',
        `${sourcePackage.name} imports ${target.package.name} without declaring it in dependencies`
      )
    }
    return null
  }

  if (sourceDesktop === 'renderer' || sourceDesktop === 'preload') {
    if (target.kind !== 'package') return null
    if (target.package.name !== 'mahas-contracts') {
      return issue(
        'UI_PACKAGE_DIRECTION',
        `${sourceDesktop} may import only type-only mahas-contracts; ${target.package.name} is not a UI dependency`
      )
    }
    if (!typeOnly) {
      return issue(
        'UI_CONTRACT_TYPE_ONLY',
        `${sourceDesktop} must import mahas-contracts with import type or export type`
      )
    }
    return null
  }

  if (sourceDesktop === 'main' && target.kind === 'package') {
    if (!desktopMainDependencies.has(target.package.name)) {
      return issue(
        'MAIN_PACKAGE_DIRECTION',
        `src/main may not import ${target.package.name}; it composes contracts, harness-config, runtime, and client only`
      )
    }
  }
  return null
}

export function formatBoundaryIssue({ filename, specifier, issue: boundaryIssue, root = REPO_ROOT }) {
  const displayPath = relative(root, filename).split(sep).join('/') || filename
  return `${displayPath}: ${boundaryIssue.code}: ${boundaryIssue.message} [${specifier}]`
}
