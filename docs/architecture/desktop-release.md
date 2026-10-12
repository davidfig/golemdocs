# Releasing the desktop app

The desktop app is a shell around golemdocs.com ([desktop.md](desktop.md)), so almost every change ships by deploying the website. The installers only need rebuilding when the shell itself changes (Rust code, `tauri.conf.json`, capabilities, icons), and for each numbered release so downloads carry the current version.

## What a release does

`.github/workflows/desktop-release.yml` runs when a `v*` tag is pushed (or by hand from the Actions tab, given an existing tag):

1. **check**: the tag must equal the version in `package.json`, `desktop/src-tauri/tauri.conf.json` and `desktop/src-tauri/Cargo.toml`. If not, nothing is built.
2. **build** on three runners, each running `cargo test` first, then `tauri-action`:
   - macOS: one universal app (Apple silicon and Intel) as a `.dmg`, signed and notarized when the secrets below exist.
   - Windows: NSIS `.exe` and `.msi`. **Not signed yet**, so SmartScreen warns on first run.
   - Linux (Ubuntu 22.04): `.AppImage`, `.deb`, `.rpm`.
3. The installers are attached to a **draft** GitHub Release named for the tag. Nothing is public until the draft is published.

The Tauri command line comes from `npx @tauri-apps/cli@<pinned>` in the workflow (`TAURI_CLI`), not from a workspace dependency; locally `cargo tauri` does the same job.

## Releasing

1. Do the normal release ([build-and-testing.md](build-and-testing.md)): changelog, version bump, commit, tag, push `main` and the tag, deploy the website first. The version must be bumped in `tauri.conf.json`, `Cargo.toml` and the `golemdocs-desktop` entry of `Cargo.lock` too, or the check job fails.
2. Wait for the **Desktop release** run to finish, open the draft release on GitHub, install the `.dmg` on a Mac and open it (no Gatekeeper warning on a signed build), check File › Vault Folder and the menu bar, then publish the draft.
3. To rebuild a tag without a new version (a failed runner, a secret fixed later): Actions › Desktop release › Run workflow, with the tag. The draft's files are replaced.

## One-time setup: Apple signing and notarization

Needs a paid Apple Developer account. Six secrets go into the repository's **Settings › Secrets and variables › Actions**:

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | the **Developer ID Application** certificate with its private key, exported from Keychain Access as a `.p12`, then base64 encoded: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | the certificate's full name, for example `Developer ID Application: Your Name (TEAMID)` (`security find-identity -v -p codesigning` lists it) |
| `APPLE_ID` | the Apple ID email used for notarization |
| `APPLE_PASSWORD` | an **app-specific password** for that Apple ID (appleid.apple.com › Sign-In and Security › App-Specific Passwords), not the account password |
| `APPLE_TEAM_ID` | the 10-character team id (developer.apple.com › Membership details) |

A *Developer ID Application* certificate is the right one for distribution outside the App Store; create it in developer.apple.com › Certificates if there is none. Missing any secret does not fail the build: the Mac job logs a warning (`Mac signing`) and produces an unsigned app.

Tauri signs with the hardened runtime and then submits the app to Apple's notary service and staples the ticket; the notarization wait is part of the job (typically a few minutes).

## Not done yet

- **Windows signing**: needs a code-signing certificate (or Azure Trusted Signing). Until then, the first run on Windows shows a SmartScreen warning ("More info › Run anyway").
- **Auto-update** (`tauri-plugin-updater`, a new dependency, so it needs approval): without it a user reinstalls to get a new shell. The web content always updates itself.
- **A download page** on the website (`client/home/template.html` and every locale) linking to the latest release.
- **Linux/Windows window chrome**: the window uses an overlay title bar and the menus in the page; the native menu bar is Mac-only. Check both on real machines before announcing them.
