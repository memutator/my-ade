// Desktop-side resolution of the builtin.harness-runtime Pack.
//
// The Pack revision is the single source for harness labels, match patterns,
// resume recipes, hook installers and maintenance declarations. This module
// resolves where the builtin Packs live (env override → packaged resources →
// repo checkout), loads the data once, and hands the desktop the concrete file
// paths the installers/refreshers write.
//
// A missing or malformed Pack is reported as a capability problem — never as an
// empty roster that silently disables hook installation. Nothing here mutates
// user configuration.

import { app } from 'electron'
import { join } from 'path'
import os from 'os'
import {
  HARNESS_RUNTIME_PACK_DIR,
  harnessRuntimeHookScriptPath,
  installerPlan,
  loadHarnessRuntimePack,
  resolveBuiltinPacksDir,
  type HarnessRuntimePack,
  type InstallerPlan
} from '../../packages/mahas-harness-config/src/runtime-pack.ts'

export interface HarnessPackLoad {
  pack?: HarnessRuntimePack
  packDir: string
  hookScriptPath?: string
  error?: string
}

let memo: HarnessPackLoad | null = null

export function builtinPacksDir(): string {
  return resolveBuiltinPacksDir({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath
  })
}

/** Load (and memoize) the builtin harness-runtime Pack revision. */
export function loadHarnessPack(refresh = false): HarnessPackLoad {
  if (memo && !refresh) return memo
  const packDir = join(builtinPacksDir(), HARNESS_RUNTIME_PACK_DIR)
  try {
    const pack = loadHarnessRuntimePack(packDir)
    memo = { pack, packDir, hookScriptPath: harnessRuntimeHookScriptPath(pack) }
  } catch (error) {
    memo = {
      packDir,
      error:
        'harness runtime Pack unavailable at ' +
        packDir +
        ': ' +
        (error instanceof Error ? error.message : String(error))
    }
  }
  return memo
}

/** Resolve one installer declaration against a HOME. */
export function harnessInstallerPlan(
  id: string,
  home: string = os.homedir()
): InstallerPlan | null {
  const loaded = loadHarnessPack()
  if (!loaded.pack || !loaded.hookScriptPath) return null
  try {
    return installerPlan(loaded.pack, id, loaded.hookScriptPath, home)
  } catch {
    return null
  }
}

/** Installer ids in Pack declaration order — the Settings roster. */
export function harnessInstallerIds(): string[] {
  const loaded = loadHarnessPack()
  return loaded.pack ? Object.keys(loaded.pack.installers.byId) : []
}
