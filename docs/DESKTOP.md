# Desktop app (macOS, Windows, Linux)

Secretary for desktop is a Tauri 2 shell around the same web UI.

## Modes

| | **Local mode** (default) | **Server mode** |
|---|---|---|
| Where data lives | on this computer (embedded PostgreSQL via PGlite in the app data folder) | your hosted or self-hosted Secretary server |
| Encryption key | generated on first run, kept in the OS credential store | server's `MASTER_KEY` |
| Scheduled briefings and reviews | run **while the app is running** (it can stay in the tray/menu bar), and catch up when it starts | run on the server even when the computer is off |
| OAuth integrations | need OAuth app credentials (see below) | configured once on the server |

Switch modes on the sign-in screen → **Server settings**.

**Scheduling limitation (local mode):** operating systems don't let a desktop app run code while it's fully quit. To keep briefings on time:

- turn on **Settings → Automations → Launch at login** (the app starts minimized to the tray);
- leave **Keep running when the window is closed** on.

If the computer was off at briefing time, the briefing is prepared as soon as the app starts (same day). For guaranteed delivery while the computer is off, use server mode.

## Features

- Tray / menu-bar icon. Click opens the quick view (today's priorities, next meetings, quick add). The menu has Open Today, Quick view and Quit. The tooltip shows the unread count, and on macOS the count also appears in the menu bar.
- Global shortcut **⌘⇧Space** (macOS) / **Ctrl+Shift+Space** (Windows/Linux) toggles the quick view.
- In-app shortcuts: **⌘K / Ctrl+K** command palette, **N** new task, **G** then **T/K/C/I/R/P/A/S** to jump to a section.
- Native notifications, with message previews off by default.
- Launch at login (macOS LaunchAgent, Windows registry, Linux autostart entry).
- Single instance: launching it again focuses the existing window.
- OAuth sign-in opens in your default browser. The app picks up the new connection automatically.
- Session token storage: macOS Keychain, Windows Credential Manager, or Linux Secret Service (GNOME Keyring / KWallet). If no Secret Service is running, the app falls back to a file readable only by your user (`0600`) in the app data directory.

## Building

Prerequisites: Rust (stable), Node 22, pnpm. On Linux you also need `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`.

```bash
pnpm install
```

```bash
pnpm desktop:build
```

This builds the web app, the server bundle and the sidecar, then runs `tauri build`. Output goes to `apps/desktop/src-tauri/target/release/bundle/`:

- macOS: `.app` and `.dmg`
- Windows: `.msi` and NSIS `-setup.exe`
- Linux: `.deb`, `.rpm` and `.AppImage`

The local-mode server ships inside the app: a copy of the build machine's Node.js runtime (as `secretary-node`) plus `resources/server`. **Build each platform on that platform.** The GitHub Actions workflow `.github/workflows/desktop.yml` does this on macOS (Apple Silicon and Intel), Windows and Ubuntu runners, and uploads the installers to a draft release.

For development:

```bash
pnpm desktop:dev
```

This starts Vite and the Tauri window. The window uses the Vite dev server.

### Signing, notarization, updates

- **macOS**: set the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific) and `APPLE_TEAM_ID` repository secrets. Unsigned builds work, but Gatekeeper warns on first launch.
- **Windows**: configure `bundle.windows.certificateThumbprint` or a signing service for SmartScreen reputation.
- **Auto-update**: run `pnpm --filter @secretary/desktop tauri signer generate`. Store the private key and password as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. Set repository variables `TAURI_UPDATER_PUBKEY` (the public key) and `TAURI_UPDATER_ENDPOINT` (for example `https://github.com/<you>/<repo>/releases/latest/download/latest.json`). Both values are compiled into release builds. Builds without them say "Automatic updates aren't configured for this build" instead of failing.

### OAuth in local mode

The local server listens on `http://127.0.0.1:47821` (falling back to a random port only if 47821 is busy). Register redirect URIs like `http://127.0.0.1:47821/api/integrations/callback/google` in your own OAuth apps. Google and Microsoft accept loopback redirects. Slack requires HTTPS, so use server mode for Slack.

Local mode reads OAuth client credentials from a `.env`-style file at `<app config dir>/server.env`, when present (for example `GOOGLE_CLIENT_ID=…`). The simplest path for teams is **server mode**: configure OAuth once on a server and point the desktop apps at it.

## Verified in this repository

- Linux: `tauri build` produced `.deb`, `.rpm` and `.AppImage`. The packaged `.deb` was launched under Xvfb. It started its bundled server on a random loopback port in local mode, created its PGlite database, and stored its master key (file fallback, because the container has no Secret Service).
- macOS and Windows: the code is cross-platform and the CI matrix builds them. They were **not built or run in the authoring environment** (a Linux container), so verify the first CI run.
