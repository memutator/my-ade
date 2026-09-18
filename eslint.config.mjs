import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', 'resources/**', 'tools/**'] },
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
  // ── IMP-01 package boundary (see packages/README.md) ───────────────────
  // The packages/* dependency direction is enforced at import level:
  //   contracts  ← harness-config, execution-host, runtime, cli
  //   harness-config ← runtime, cli      execution-host: contracts only
  //   runtime    ← cli, src/main         src/preload+renderer: contracts
  //   types only (never the runtime repository); packages never import src/.
  {
    files: ['packages/mahas-contracts/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../mahas-*', '../../mahas-*/**', '../../../src/**'],
              message:
                'mahas-contracts is the shared base — it must not import other packages or desktop src'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['packages/mahas-harness-config/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../../mahas-runtime/**',
                '../../mahas-execution-host/**',
                '../../mahas-cli/**',
                '../../../src/**'
              ],
              message: 'harness-config depends on mahas-contracts only'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['packages/mahas-execution-host/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../../mahas-runtime/**',
                '../../mahas-cli/**',
                '../../mahas-harness-config/**',
                '../../../src/**'
              ],
              message:
                'execution-host is a separate daemon — it depends on contracts only, never on the runtime internals it serves'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['packages/mahas-runtime/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../mahas-execution-host/**', '../../mahas-cli/**', '../../../src/**'],
              message:
                'runtime depends on contracts + harness-config — it is not imported into or importing host/cli/desktop internals'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['packages/mahas-cli/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../mahas-execution-host/**', '../../../src/**'],
              message:
                'the CLI is a client of contracts/runtime/harness-config — never of execution-host internals or desktop src'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/main/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/packages/mahas-execution-host/**', '**/packages/mahas-cli/**'],
              message:
                'the desktop composes contracts/runtime/harness-config — it spawns the execution-host by path, never imports it'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/preload/**/*', 'src/renderer/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/packages/mahas-runtime/**',
                '**/packages/mahas-execution-host/**',
                '**/packages/mahas-cli/**',
                '**/packages/mahas-harness-config/**'
              ],
              message:
                'the renderer contract port is mahas-contracts type imports + the window.mahas IPC surface — never the runtime repository (IMP-01 §4.2)'
            }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
