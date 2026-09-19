# App build + e2e — isolated-copy re-verification of the `tools/e2e.mjs` 37/0 claim

- Repo: `/home/pyosechang/projects/ade-wt-mahas-architecture`
- Branch: `mahas-architecture`, claimed HEAD `83a6d21`; actual HEAD `8f69594` = `83a6d21` + one records-only commit (3 md files, zero diff under `tools/`, `src/`, `package.json`) — code under test is identical.
- Method: `rsync -a --exclude=node_modules` → `/tmp/mahas-ver-app/repo`; `node_modules` replaced with a symlink to the resolved real target `/home/pyosechang/projects/my-ade/node_modules`. `git status` in the copy: clean, HEAD `8f69594`.
- Isolation: `HOME=/tmp/mahas-ver-app/home`, `XDG_CONFIG_HOME=/tmp/mahas-ver-app/xdg`, `XDG_DATA_HOME=/tmp/mahas-ver-app/data` exported for both commands; `tools/e2e.mjs` additionally overrides `XDG_CONFIG_HOME` per boot to `mkdtemp mahas-e2e-*` (removed at suite end) and runs each app instance with `MAHAS_TEST=1` (headless, `focusable:false`, window never maps) + `ELECTRON_DISABLE_SANDBOX=1` + `MAHAS_HOOK_DEBUG=1`.
- Constraint check: no writes to the shared worktree (`out/main/index.js` mtime still `Sep 18 22:24`; `git status` clean before and after). Real `~/.config/mahas` writes observed during the window are attributable to the user's **installed** app `/opt/Mahas/mahas` (pid 175307, `--user-data-dir=~/.config/mahas`) which was running independently — the e2e children's env had fake HOME + per-boot XDG, and `refreshInstalledHooks`/`runtimeConfigDir`/`devinLocks` all resolve through `XDG_*`/homedir (verified at `src/main/hookInstallers.ts:42-43,421-453`, `src/main/eventsFile.ts:33-34`, `src/main/runtimeClient.ts:107-109,138-139`, `src/main/devinLocks.ts:21-22`; `ensureControlPlane` early-returns on `MAHAS_TEST`).

## Results

| # | Check | Command | Claim | Observed | Verdict |
|---|-------|---------|-------|----------|---------|
| 1 | app build | `npm run build` (typecheck + `electron-vite build`) | green | exit 0; `out/{main,preload,renderer}` produced (`out/main/index.js` 86 648 B); tail `✓ built in 4.76s` | pass |
| 2 | app e2e | `node tools/e2e.mjs` (all 8 scenarios) | 37 passed, 0 failed | `37 passed, 0 failed`, exit 0 | **reproduced** |

### Scenario breakdown (all checks passed)

| Scenario | Checks | Result |
|----------|--------|--------|
| orphans — app quit kills agent processes | 2 | 2/2 |
| resume — two sessions restore to their own tabs | 5 | 5/5 |
| attention — attended/ambient/away + read-on-view | 7 | 7/7 |
| status — working pulse / input amber / error red dots | 5 | 5/5 |
| adopt — previous-run orphan events re-register | 2 | 2/2 |
| projectrm — removing a project drops workspaces + cleans state | 8 | 8/8 |
| browserfile — html opens as file:// tab in browser pane | 3 | 3/3 |
| tabdnd — hold-drag reorder/split/stack/cross-workspace | 5 | 5/5 |
| **total** | **37** | **37/37** |

## Environment notes

- Ran on the real desktop session (`DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`); no Xvfb needed — `MAHAS_TEST` windows never map, and `MAHAS_FAKE_FOCUS` pins the `win:state` verdict for focus-dependent checks.
- Electron driven over CDP (`--remote-debugging-port=93xx`, `Input.dispatchMouseEvent` for the real drag pipeline in `tabdnd`); ptys spawn `node tools/mahas-fake.mjs` inside the copy — `node` resolves via inherited PATH (nvm `v24.20.0`), unaffected by the fake HOME.
- `browserfile` webview navigation verified (`file:///tmp/mahas-e2e-d2Sl6Z/pa%20ge%231.html` — space + `#` encoding survived).
- Concurrent with the user's live installed app — no interference observed; per-run `XDG_CONFIG_HOME` + `MAHAS_SESSION` scoping keep the channels disjoint.

## Raw logs

- `/tmp/mahas-ver-app/logs/build.log` — full `npm run build` output (exit 0)
- `/tmp/mahas-ver-app/logs/e2e.log` — full suite output incl. `E2E_EXIT=0`
- `/tmp/mahas-ver-app/repo/` — the isolated copy (23 MB incl. rebuilt `out/`; kept as evidence, under the 1 GB cleanup threshold)

## Verdict

**Reproduced.** `npm run build` green and `node tools/e2e.mjs` → `37 passed, 0 failed` (exit 0) in a fully isolated copy — matching the coordinator's claim verbatim. This closes the two items `smoke-baseline.md` had to mark not-run (build, e2e) under its no-repo-write constraint.
