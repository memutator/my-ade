# Packaging

```bash
npm run build:linux   # electron-vite build && electron-builder --linux
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

`files` strips sources and dev config from the asar — including
`'!node_modules/@homebridge/node-pty-prebuilt-multiarch/**'`, which must **not**
live inside the asar (see below). `asarUnpack: resources/**` additionally lands
`resources/` under `app.asar.unpacked/`.

`extraResources` copies into `process.resourcesPath`
(`/opt/mahas/resources/` in the deb):

| Source                                                 | Destination                                            | Why                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources/pty-host.cjs`                               | `pty-host.cjs`                                         | spawned by main under system Node (`process.resourcesPath/pty-host.cjs`)                                                                                                                                                  |
| `resources/webview-preload.cjs`                        | `webview-preload.cjs`                                  | `file://` URL handed to the `<webview preload>` attribute                                                                                                                                                                 |
| `resources/agents/`                                    | `agents/`                                              | `agents:manifest` reads `process.resourcesPath/agents/manifest.json`                                                                                                                                                      |
| `node_modules/@homebridge/node-pty-prebuilt-multiarch` | `node_modules/@homebridge/node-pty-prebuilt-multiarch` | pty-host runs under **system Node outside the asar** — its `require('@homebridge/…')` resolves by Node's walk-up from `resources/pty-host.cjs` into `resources/node_modules/`. The asar copy is excluded via `files '!…'` |

The node-pty copy is filtered to the `linux-x64` prebuild only (other arches,
`third_party`, `typings`, `scripts`, tests, `binding.gyp` stripped).

Known gap: the hook scripts `mahas-hook.cjs` / `mahas-opencode-plugin.js` are only
shipped via `asarUnpack` (`app.asar.unpacked/resources/`), while
`src/main/hooks.ts` resolves them as `process.resourcesPath/<name>` in
packaged builds — hook install from a deb/AppImage build fails on the missing
source file. Fix by adding both to `extraResources` (dev paths are unaffected).

## deb

Installs to `/opt/mahas`, links `/usr/bin/mahas` via `update-alternatives`.

`postinst`:

- probes `unshare --user` — if user namespaces are unavailable it runs
  `chmod 4755 /opt/mahas/chrome-sandbox` (the SUID fallback), else `chmod 0755`
- installs the bundled AppArmor profile
  (`/opt/mahas/resources/apparmor-profile` → `/etc/apparmor.d/mahas`, an abi-4.0
  `userns` unconfined profile) when the running AppArmor supports it —
  Ubuntu 24.04+; skipped on 22.04. `postrm` unloads and removes it
- refreshes the mime and desktop databases

Desktop entry (`/usr/share/applications/mahas.desktop`):
`Exec=/opt/mahas/mahas %U`, `Icon=mahas`, `StartupWMClass=mahas`. `desktopName: "mahas"`
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

pty-host is spawned as `<node> …/pty-host.cjs` — a real Node install must
exist somewhere on the system. Resolution order (`nodeBinary()` in
`src/main/pty.ts`):

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
sudo dpkg -i dist/mahas_*_amd64.deb
```

The new icon may not appear until the desktop cache refreshes —
`kbuildsycoca6` (KDE) or log out/in.
