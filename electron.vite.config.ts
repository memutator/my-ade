import { resolve } from 'path'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [
      {
        name: 'mahas-service-artifacts',
        apply: 'build',
        closeBundle() {
          // The daemon-side services (mahasd / execution-host / mahas CLI) are
          // bundled by tools/build-services.mjs into out/services, which
          // electron-builder.yml ships as resources/services. Failing the
          // build here beats packaging a desktop app whose control plane
          // cannot be started.
          const script = resolve('tools/build-services.mjs')
          if (!existsSync(script)) {
            throw new Error(`service bundle script is missing: ${script}`)
          }
          execFileSync(process.execPath, [script], { stdio: 'inherit' })
        }
      }
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
