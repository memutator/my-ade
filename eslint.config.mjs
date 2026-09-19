import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import {
  REPO_ROOT,
  discoverPackages,
  formatBoundaryIssue,
  specifiersAreTypeOnly,
  validateImport
} from './tools/boundary-policy.mjs'

const boundaryPackages = discoverPackages(REPO_ROOT)

/**
 * `no-restricted-imports` compares raw strings, so ../../.. depth changes can
 * bypass it. This rule resolves the target package before applying the
 * dependency graph. tools/check-boundaries.mjs uses the same policy for every
 * source file and its temporary fixtures, including the `import { type X }`
 * form that typescript-eslint reports as a value clause with type-marked
 * specifiers.
 */
const mahasBoundaryPlugin = {
  rules: {
    'resolved-package-imports': {
      meta: {
        type: 'problem',
        docs: { description: 'enforce resolved mahas package dependency boundaries' },
        schema: []
      },
      create(context) {
        const filename = context.filename ?? context.getFilename()
        const inspect = (node, source, typeOnly) => {
          if (!source || typeof source.value !== 'string') return
          const boundaryIssue = validateImport({
            root: REPO_ROOT,
            packages: boundaryPackages,
            filename,
            specifier: source.value,
            typeOnly
          })
          if (!boundaryIssue) return
          context.report({
            node: source,
            message: formatBoundaryIssue({
              filename,
              specifier: source.value,
              issue: boundaryIssue,
              root: REPO_ROOT
            })
          })
        }
        const literalArgument = (node) => {
          const [argument] = node.arguments ?? []
          return argument?.type === 'Literal' && typeof argument.value === 'string' ? argument : null
        }
        const importClauseIsTypeOnly = (node) => {
          if (node.importKind === 'type') return true
          const specifiers = node.specifiers ?? []
          const named = specifiers.filter((specifier) => specifier.type === 'ImportSpecifier')
          return named.length === specifiers.length && specifiersAreTypeOnly(named)
        }
        const exportSpecifiersAreTypeOnly = (node) => {
          if (node.exportKind === 'type') return true
          if (!node.specifiers || node.specifiers.length === 0) return false
          return specifiersAreTypeOnly(node.specifiers)
        }
        return {
          ImportDeclaration(node) {
            inspect(node, node.source, importClauseIsTypeOnly(node))
          },
          ExportNamedDeclaration(node) {
            if (node.source) inspect(node, node.source, exportSpecifiersAreTypeOnly(node))
          },
          ExportAllDeclaration(node) {
            inspect(node, node.source, node.exportKind === 'type')
          },
          ImportExpression(node) {
            inspect(node, node.source, false)
          },
          CallExpression(node) {
            const dynamicImport = node.callee?.type === 'Import'
            const requireCall = node.callee?.type === 'Identifier' && node.callee.name === 'require'
            if (dynamicImport || requireCall) inspect(node, literalArgument(node), false)
          },
          TSImportType(node) {
            const argument = node.argument?.literal ?? node.argument
            inspect(node, argument, true)
          }
        }
      }
    }
  }
}

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', 'resources/**', 'tools/**', 'mahas-architecture/**'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  eslintConfigPrettier,
  // Plain JavaScript (Pack collectors, hook scripts, CLI helpers) carries no
  // type annotations, so rules that require them are noise, not findings.
  // @electron-toolkit's own escape hatch uses `files: ['*.js', '*.mjs']`, which
  // in flat config matches only top-level files — a nested collector under
  // integrations/packs/** keeps the TypeScript rules applied to it. These two
  // entries re-state the intent with patterns that actually match, and give
  // each module system its real sourceType (`.cjs` may use `require`).
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { sourceType: 'module' },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: [
      'packages/**/*.{ts,tsx,mts,cts}',
      'src/main/**/*.{ts,tsx,mts,cts}',
      'src/preload/**/*.{ts,tsx,mts,cts}',
      'src/renderer/**/*.{ts,tsx,mts,cts}'
    ],
    plugins: {
      'mahas-boundaries': mahasBoundaryPlugin
    },
    rules: {
      'mahas-boundaries/resolved-package-imports': 'error'
    }
  }
)
