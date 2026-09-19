# Packaging

```bash
npm run build:linux   # typecheck, boundaries, docs, bundles, then electron-builder
```

Config: `electron-builder.yml`. Linux targets: **AppImage** and **deb**, written
to `dist/` (the snap target was dropped — no snapcraft on this machine).

Artifacts (`<ver>` = `package.json` `version`):

- `dist/mahas-<ver>.AppImage`
- `dist/mahas_<ver>_amd64.deb`
- `dist/latest-linux.yml` — update manifest for the placeholder `generic`
  publish provider
- `dist/linux-unpacked/` — unpacked tree (also produced directly by
  `npm run build:unpack`)

## Resource layout

`files` is a positive allowlist for application files — `out/main/**`, `out/preload/**`,
`out/renderer/**`, `resources/**`, and `package.json` ship inside the asar, alongside automatically included production dependencies.
Source trees (`packages/*/src`, `tools/`, `docs/`, worktrees,
`node_modules/@homebridge/node-pty-prebuilt-multiarch/**`) stays out; the
service bundles and the Pack tree arrive separately through `extraResources`.
`asarUnpack: resources/**` additionally lands `resources/` under
`app.asar.unpacked/`.

`extraResources` copies into `process.resourcesPath`
(`/opt/Mahas/resources/` in the deb):

| Source                                                 | Destination                                            | Why                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `out/services/` (`*.mjs` only)                          | `services/`                                            | the `mahasd`, `execution-host`, and `mahas` CLI bundles from `npm run build:services`; `serviceBootstrap` spawns them under system Node ≥24                                                                                  |
| `integrations/packs/`                                  | `integrations/packs/`                                  | the built-in Pack tree (harness-runtime + collectors + builtin-offerings); main installs hook files from it and mahasd receives it as `MAHAS_BUILTIN_PACKS_DIR`                                                              |
| `resources/pty-host.cjs`                               | `pty-host.cjs`                                         | spawned by main under system Node (`process.resourcesPath/pty-host.cjs`)                                                                                                                                                  |
| `resources/webview-preload.cjs`                        | `webview-preload.cjs`                                  | `file://` URL handed to the `<webview preload>` attribute                                                                                                                                                                 |
| `resources/agents/`                                    | `agents/`                                              | `agents:manifest` reads `process.resourcesPath/agents/manifest.json`                                                                                                                                                      |
| `node_modules/@homebridge/node-pty-prebuilt-multiarch` | `node_modules/@homebridge/node-pty-prebuilt-multiarch` | pty-host runs under **system Node outside the asar** — its `require('@homebridge/…')` resolves by Node's walk-up from `resources/pty-host.cjs` into `resources/node_modules/`. The asar copy is excluded via `files '!…'` |

The node-pty copy is filtered to the `linux-x64` prebuild only (other arches,
`third_party`, `typings`, `scripts`, tests, `binding.gyp` stripped).

The hook transports live inside the Pack that owns them
(`integrations/packs/harness-runtime/hooks/`, landed at
`<resourcesPath>/integrations/packs/` by `extraResources`), so there is no separate
`resources/mahas-hook.cjs` / `resources/mahas-opencode-plugin.js` copy to keep in
sync: main installs the Pack's own files into `$MAHAS_CONFIG_DIR` and opencode's
plugin directory, and mahasd receives the same tree as `MAHAS_BUILTIN_PACKS_DIR`.
`resources/agents/manifest.json` is a generated projection of the same Pack
(`node integrations/packs/harness-runtime/project.mjs`), kept because
`agents:manifest` and the pty-host detector read that path; the Pack fixture
fails if the projection drifts.

## deb

Installs to `/opt/Mahas`, links `/usr/bin/mahas` via `update-alternatives`.

The repo declares no `afterInstall`/`afterRemove`/`appArmorProfile` hooks —
the deb scripts are electron-builder's default templates
(`app-builder-lib/templates/linux/{after-install,after-remove,apparmor-profile}.tpl`),
and fpm packaging copies the generated `apparmor-profile` into `resources/`
automatically. What those defaults do:

`postinst`:

- probes `unshare --user` — if user namespaces are unavailable it runs
  `chmod 4755 /opt/Mahas/chrome-sandbox` (the SUID fallback), else `chmod 0755`
- installs the bundled AppArmor profile
  (`/opt/Mahas/resources/apparmor-profile` → `/etc/apparmor.d/mahas`, an abi-4.0
  `userns` unconfined profile) when the running AppArmor supports it —
  Ubuntu 24.04+; skipped on 22.04. `postrm` unloads and removes it
- refreshes the mime and desktop databases

Desktop entry (`/usr/share/applications/mahas.desktop`):
`Exec=/opt/Mahas/mahas %U`, `Icon=mahas`, `StartupWMClass=mahas`. `desktopName: "mahas"`
in `package.json` plus `linux.syncDesktopName: true` keep the window's
`WM_CLASS` matching the desktop file so the dock associates icon and window.
Icon lands at `/usr/share/icons/hicolor/512x512/apps/mahas.png` (from
`build/icon.png`).

## AppImage

`artifactName: ${name}-${version}.${ext}`. The chrome-sandbox inside an
AppImage mount can't be setuid, so on systems where unprivileged user
namespaces are disabled or blocked, run it with `ELECTRON_DISABLE_SANDBOX=1`
or `--no-sandbox`.

## Runtime requirement: a Node binary

pty-host is spawned as `<node> …/pty-host.cjs`, and the bundled services
(`resources/services/{mahasd,execution-host}.mjs`) are spawned under a system
Node too — `serviceBootstrap` probes candidates with `--version` and requires
**Node ≥24** for them, so a machine with only an older Node gets live
terminals but dead daemons. pty-host itself is plain CJS and has no version
floor. A real Node install must exist somewhere on the system. Resolution
order (`nodeBinary()` in `src/main/pty.ts`; `serviceBootstrap` keeps a
parallel candidate list with the same env-var convention):

1. `MAHAS_NODE` / `NODE_BINARY` env vars
2. `node --version` on `PATH`
3. fixed paths: `/usr/bin/node`, `/usr/local/bin/node`, `/snap/bin/node`,
   linuxbrew, `~/.volta/bin/node`, `~/.local/bin/node`, `~/.asdf/shims/node`
4. newest version dir under `~/.nvm/versions/node`,
   `~/.local/share/mise/installs/node`, `~/.local/share/fnm/node-versions`,
   `~/.asdf/installs/nodejs`

Override with `MAHAS_NODE=/path/to/node`. When nothing resolves the app still
runs — terminals just stay dead.

## Install / upgrade

```bash
sudo apt install --reinstall ./dist/mahas_<ver>_amd64.deb
```

The new icon may not appear until the desktop cache refreshes —
`kbuildsycoca6` (KDE) or log out/in.
