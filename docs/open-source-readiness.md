# Open-source readiness

Audit done 2026-10-01 against `main` at 0.3.1 (81 commits, one author). Nothing here commits to open sourcing; it records what would have to be true, so the decision can wait.

## 1. Secrets and history

**No secrets found.** Checked the whole history (not just the tree) for key, token and credential patterns (Anthropic/OpenAI-style `sk-`, Polar `polar_*` and `whsec_*`, AWS, GitHub, Slack, Google, JWTs, private-key blocks) and for quoted `secret/token/api_key/password = "..."` assignments. No `.env`, `.dev.vars`, key or database file was ever added. Secrets live only in Wrangler secrets (listed at the bottom of `server/wrangler.jsonc`) and the git-ignored `server/.dev.vars`; `server/.dev.vars.example` holds blanks.

Worth fixing before going public (none are secrets). **Done 2026-10-01** for the first two, partly for the third:

- `server/wrangler.jsonc` commits the Cloudflare **account id** (`c26bf9c3…`) and the production and dev **D1 database ids**. They need a token to be useful, but they identify the account. **Fixed:** `wrangler.jsonc` now has `REPLACE_…` placeholders; the real ids are in the git-ignored `server/wrangler.local.json` (template: `wrangler.local.example.json`), and `scripts/wrangler-config.ts` merges them into the git-ignored `wrangler.generated.jsonc` that the server scripts pass to wrangler. They are still in the history, which is harmless but another reason to publish from a fresh repo.
- Commit author email `david@yopeyopey.com` is on all 80 commits. `.mailmap` now maps it to `david@golemdocs.com` for `git log` and `shortlog`, but that does not change the commits themselves, so the old address is still in the raw history and on GitHub. Publishing from a squashed fresh repo is the only real fix. `david@golemdocs.com` and `support@golemdocs.com` appear in the home page and legal text, which are meant to be public.
- `scripts/` and CI reference no private services. `.github/workflows/ci.yml` uses no secrets.
- Test fixtures are generated and anonymous (`pdf/test/make-fixtures.sh`; producers are reportlab, matplotlib, pdflatex and so on). The `.docx` corpus is fetched from a public repo at a pinned commit and is not committed.

Re-run before any release: a tool such as gitleaks over the full history, since this audit was pattern greps, not a scanner.

## 2. Decoupling

The editor core is already separable. `docx`, `layout`, `ops`, `editor`, `pdf` and `odt` mention no billing, Polar, subscription, auth or account code, and none import `client` or `server`. They have **no third-party runtime dependencies**.

The hosted-service code is concentrated in two places:

- `server/` (the Worker): `billing.ts`, `subscriptions.ts`, `accounts.ts`, `auth*.ts`, `providers.ts`, `cf.ts`, `userDb.ts`, `room*.ts`. Only `worker.ts` and the routes it calls import billing/subscriptions.
- `client/src/`: `subscription.ts`, `auth.ts`, `ui/billingPanel.ts`, `ui/syncButton.ts`, `ui/signIn.ts`, `ui/accountButton.ts`, plus the strings for these in `i18n/`.

An open-core split would keep the packages above and the `client` editor open and treat `server/` and the billing/auth UI as the hosted product. The remaining work is that the `client` imports the account/billing modules directly rather than through an interface, so a build without them would need those seams cut (`main.ts`, `chrome.ts`, `actions.ts`).

## 3. Licenses

**Dependencies:** all dev-only, nothing ships in the client bundle from npm. Installed licenses: MIT, Apache-2.0, ISC, BSD-3-Clause, CC0-1.0, MIT-or-Apache-2.0. No GPL/AGPL. One LGPL-3.0 item: `@img/sharp-libvips`, a prebuilt library pulled in by `sharp` (used by `scripts/`, not distributed), so it doesn't constrain your license.

**Bundled assets:** all fonts are open substitutes for Microsoft fonts, each with its license file and a pinned, hash-checked source in `scripts/fonts/sources.ts`:

| Folder | Actual font | License |
|---|---|---|
| arial, times-new-roman, courier-new | Liberation | OFL-1.1 |
| calibri / cambria / georgia | Carlito / Caladea / Gelasio | OFL-1.1 |
| segoe-ui | Selawik | OFL-1.1 |
| comic-sans-ms | Comic Relief | OFL-1.1 |
| libertinus-math, noto-sans-* | Libertinus, Noto (Adobe Source) | OFL-1.1 |

Dictionaries are Hunspell/SCOWL (permissive, `client/public/dictionaries/LICENSE.txt`).

**Gaps to close:**

- No `LICENSE` file for the project itself, and the `package.json`s have no `license` field.
- No top-level `NOTICE` / third-party list. The OFL licenses require shipping their text with the fonts (already done per folder); a single `THIRD_PARTY.md` pointing at them would be tidier.
- The OFL "Reserved Font Names" (Liberation, Carlito, Selawik and others) mean the files can't be renamed and redistributed under those folder names as if they were the original fonts, but the font metrics/atlas outputs generated here are your own build artifacts. Confirm that reading if you publish the `*.webp` atlases.
- **Naming:** the packages are `@word/*` and the repo says "Word". "Word" is a Microsoft trademark, and `docx` compatibility is fine to claim ("opens .docx files") but not to use as a product name. The public name is Golem Docs, **Fixed:** the packages are now `@golemdocs/*` (and the root package is `golemdocs`).
- No `README.md`, `CONTRIBUTING.md` or security policy exists yet.

## 4. Decision (2026-10-31)

Open source, as one public repo (this one) when the time comes. Until the repo is made public, none of this has any effect.

- **Licenses:** AGPL-3.0-only for the app (`client`, `server`, `desktop`, repo root); MIT for the libraries (`docx`, `layout`, `editor`, `ops`, `odt`, `pdf`), each with its own `LICENSE`. Library source files carry an `SPDX-License-Identifier: MIT` line because they are the parts expected to be copied or used on their own; app files have no per-file headers.
- **Contributions:** a CLA ([CLA.md](../CLA.md)), so the hosted version and future relicensing stay open. Signing is `.github/workflows/cla.yml`: the author comments a fixed sentence once, and the workflow sets a `CLA` commit status. It's our own workflow (only GitHub's `actions/github-script`), because the CLA Assistant action is archived and cla-assistant.io needs an OAuth grant and is barely maintained.
- **Security:** `SECURITY.md` asks for reports through GitHub's private vulnerability reporting.
- **History:** kept. The old Cloudflare ids and author email above stay in it.
- **Added:** `LICENSE`, `CLA.md`, `CONTRIBUTING.md`, `TRADEMARKS.md`, `THIRD_PARTY_NOTICES.md`, a License section in the README, and `license` fields in every `package.json` and `desktop/src-tauri/Cargo.toml`.
- **Correction to section 3:** not all dictionaries are permissive. `de_DE` and `it_IT` are GPL, `pt_BR` LGPL/MPL, `fr_FR` MPL, `es_ES` a choice of GPL/LGPL/MPL. They are separate data files loaded at run time, so they don't affect the project's licenses; `THIRD_PARTY_NOTICES.md` lists each one.

Still to do when going public: remove `"private": true` from the library `package.json`s and give them build output and `files` for npm; make `CLA` a required status check on `main`; turn on private vulnerability reporting (GitHub offers it only on public repos).

## 5. Decision trigger (superseded by section 4)

- **Revisit open sourcing on 2026-11-01.**
- Open source if, by then: ____ (for example, fewer than N paying subscribers, or no public launch tried). Not decided yet.
- Before then, optionally try: a public launch post, a lower price or free tier, or releasing one package (`pdf`, `odt`, `docx`) as a library.
