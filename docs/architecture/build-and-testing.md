# Build, testing and release

How the monorepo is laid out, how the client is built and split into lazy chunks, how the scripts in `scripts/` and the unit and end-to-end tests work, what CI runs, and how a release is cut and deployed. Read AGENTS.md alongside this: it holds the rules (bundle budget, test expectations, changelog and release steps) that this doc maps onto the code.

## Workspace and dependency direction

pnpm workspace (`pnpm-workspace.yaml`): `client`, `server`, `docx`, `layout`, `ops`, `editor`, `pdf`, `odt`. All are `private` and **not on npm**; never look them up in the registry. Node 22.13+ (CI uses 24), pnpm 10.

```
 client ──► editor ──► layout ──► docx
   │  │        └──────► ops ─────► docx
   │  ├──► pdf  (no workspace deps)
   │  ├──► odt ──► docx
   │  └──► docx, layout, ops
 server ──► docx, ops          (client never imports server; the assistant parity
                                test reads server/src/assistantTools.ts by path)
```

Dependencies only point down: `docx` (document model, reader/writer) is the base; `layout` (fonts, text layout, pagination) and `ops` (operation engine for collaboration) build on it; `editor` combines all three; `client` consumes everything; `server` (Cloudflare Worker) uses only `docx` and `ops`. Format and layout code must not import from `client` or `server`. Dependency policy: ask before adding any dependency (AGENTS.md); the client currently has one runtime dependency (`polygon-clipping`).

| Package | Role |
| --- | --- |
| `client/` | Vite app: WebGL renderer, UI, formats, storage, layout worker host |
| `server/` | Worker: API, D1/R2/Vectorize, Durable Object rooms; serves `client/dist` as static assets |
| `docx/`, `odt/`, `pdf/` | Format libraries |
| `layout/`, `editor/`, `ops/` | Layout, editing core, collaboration ops |
| `scripts/` | Repo tooling (see below) |
| `e2e/`, `playwright.config.ts` | End-to-end tests |
| `docs/` | Docs; `server/AUTH.md` covers sign-in providers |

Root scripts (`package.json`): `dev`, `dev:client`, `dev:server`, `kill`, `build`, `typecheck` (root `tsc` over `scripts/`, then each package's `tsc`), `build:home`, `fonts`, `test`, `test:coverage`, `e2e`, `record:home`. TypeScript is shared via `tsconfig.base.json`.

## Client build and lazy chunks

`pnpm --filter @golemdocs/client build` runs `tsc && vite build` (`client/vite.config.ts`). Output goes to `client/dist`, which `server/wrangler.jsonc` serves as an SPA (`assets.directory`, `not_found_handling: single-page-application`, with `/api/*` first through the Worker). That is production only: in the `dev` and `local` environments `assets.directory` is an empty, git-ignored `server/.no-assets`, and `run_worker_first` is `/*`, so `:3001` serves just `/api` and the Worker redirects everything else to Vite on :5173, where the page comes from.

Rules (AGENTS.md "Bundle size and lazy loading"): split into its own chunk only code that is about 20 kB or more minified and not needed by most sessions; one feature, one chunk behind a single entry module that is only ever `import()`ed (never also imported statically).

- **Formats:** each is a `FormatHandler` in `client/src/formats/handlers/`, registered in `HANDLERS` in `formats/convert.ts`. Word, plain text, CSV, HTML, Markdown and pictures are static glue; ODT, RTF, PDF, markup languages, XML formats, web archives and notebooks are `import()`ed.
- **Large panels and dialogs:** lazy via `import()` in `main.ts` (math dialog, vector session `ui/vectorSession.ts`, stored-drawing helpers).
- **Layout worker:** `layout/layoutWorkerEntry.ts` is a stub; `vite.config.ts` forces the real code into a `layoutCore` chunk (`manualChunks`), because Safari re-runs a worker's entry script when a lazy chunk imports it, which would start a second worker copy. The worker is an ES module.
- **Fonts and dictionaries:** never in a JS bundle. `client/public/fonts/` (manifest, MSDF atlases `.webp`, metrics `.json`, `.ttf`) and `client/public/dictionaries/` are fetched on demand; `FontSet.ensure`/`ensurePages` (`layout/src/fonts/fontSet.ts`) loads a face or an extra page only when a document uses a character on it.
- **Locales:** each language catalog (`i18n/locales.ts`) is its own lazy chunk.
- **Check your work:** read the chunk list after a build. The `layoutWorker-*.js` and main `index-*.js` should not grow because of a new format, and a new chunk under ~20 kB should be merged back.
- Vite plugin `welcomeContent()` (`client/seo.ts`) inlines welcome text and writes the marketing pages into `dist/home/` at build ([UI](ui.md)). In dev the Vite server proxies `/api` (websockets included) to the Worker on :3001, and serves the docx corpus at `/__corpus/`.

## Scripts

| Path | Role |
| --- | --- |
| `scripts/dev.ts` (`pnpm dev`) | Creates `server/.dev.vars` from the example, applies D1 migrations, runs Vite (:5173) and `wrangler dev` (:3001) with prefixed output; uses real `dev` Cloudflare resources if configured, else fully simulated (`--local` forces it) |
| `scripts/wrangler-config.ts` | Merges `server/wrangler.local.json` into the committed `wrangler.jsonc` to make git-ignored `wrangler.generated.jsonc` (account ids stay out of git) |
| `scripts/kill.ts` (`pnpm kill`) | Stops leftover dev servers from this checkout (macOS/Linux) |
| `scripts/e2e.ts` (`pnpm e2e`) | Runs Playwright in two passes (below) |
| `scripts/coverage.ts` (`pnpm test:coverage`) | Node built-in line coverage per package; lists files no test loads |
| `scripts/fonts/` (`pnpm fonts`) | Font atlas generation (below) |
| `scripts/marketing/record-war-and-peace.ts` (`pnpm record:home`) | Re-records `client/public/home/war-and-peace.webm` from the user's dev server |

### Fonts generation

`scripts/fonts/sources.ts` lists metric-compatible open-source substitutes for Word's fonts (every download pinned by URL and sha256; msdf-atlas-gen built from a pinned commit). `generate.ts` (needs `cmake`, FreeType, libpng) writes `client/public/fonts/manifest.json` and per-family atlas, glyph JSON, `.ttf` and license. Each family's core atlas holds the characters in `charset.txt`; remaining characters go in `<id>-extra` pages (`withExtras`), and CJK pages come from `charsets.ts` (decoded from legacy standards into `charsets/<lang>-N.txt`, most-used first). Atlases are committed, so a normal checkout never runs this. `--only`, `--download-only`, `--ttf-only` narrow a run.

## Unit tests

Run `pnpm test` (all packages, `--no-bail`) or one package: `pnpm --filter @golemdocs/client test`.

- `docx`, `layout`, `ops`, `editor`, `pdf`, `odt`, `server`: `tsx --test "test/**/*.test.ts"` (Node's built-in runner).
- `client`: `node --experimental-transform-types --import ./test/setup.ts --test test/*.test.ts` (no bundler). `test/setup.ts` loads the English catalog and turns `.css` imports into empty modules. Layout-worker tests use `workerHarness.ts`; canvas and IndexedDB are faked (`fakeCanvas.ts`, `fakeIndexedDB.ts`).
- Notable cross-cutting client tests: `consistency.test.ts` (i18n keys, command ids, no literal strings), `i18n.test.ts` (translation completeness), `home.test.ts` (marketing translations), `spelling.test.ts` (welcome documents have no errors), `assistantParity.test.ts` (every server tool has a page implementation), `changelog.test.ts` (top entry is `Unreleased` or dated, only the first may be `Unreleased`).
- Server tests use `server/test/harness.ts` to fake D1, R2, Durable Objects and the AI binding.
- Corpora (`pnpm --filter @golemdocs/docx corpus`, pdf `fetch-corpus`) are downloaded, not committed; without the docx corpus the round-trip tests skip.
- Policy: new logic, bug fix or behavior change that can be tested without a browser gets a test; test pure logic over DOM code.

## End-to-end tests

Playwright (`playwright.config.ts`, specs in `e2e/<area>/*.spec.ts`: `collab`, `editing`, `files`, `layout`, `pdf`, `shell`, plus `smoke.spec.ts`). It starts its own servers: a simulated-local `wrangler dev` on :3101 with a throwaway `--persist-to` state folder (`e2e/ports.ts`, `E2E_STATE`), signed in as `DEV_USER=e2e@example.com`, and Vite on :5273. Never the `pnpm dev` ports.

- `e2e/fixtures.ts` exports `test` (extends Playwright's with an `app: App` fixture and defaults for sidebar, status bar and autocorrect) and `App`: `goto`, `blank()` (File › New with the caret in it), `ready()` (waits for `window.loaded`), `menu()`, `editor` (`#input`), `canvas` (`#canvas`), `focus()`. Each test gets a fresh browser profile.
- The editor is a canvas, so assert through `app.text()` and `window` hooks (`selectionState`, `loaded`, `pages`, `status`), the DOM of menus and dialogs, or downloaded files.
- GPU: on a non-CI Mac the browser uses Metal; elsewhere SwiftShader software GL (`E2E_SOFTWARE_GL=1` forces it).
- `scripts/e2e.ts`: pass one runs everything in parallel (workers = a third of the cores, `E2E_WORKERS` overrides; one retry, and a pass on retry is reported flaky); pass two re-runs `{ tag: '@heavy' }` tests with fewer workers. `E2E_SKIP_HEAVY=1` skips pass two. Arguments go straight to `playwright test` (single pass).
- During development run only the specs you added or changed (`pnpm e2e e2e/shell/themes.spec.ts`). For a second concurrent run give it its own ports, state and output: `E2E_CLIENT_PORT=5274 E2E_API_PORT=3102 E2E_STATE=e2e/.state-2 pnpm e2e <paths> --workers=2 --output=e2e/.results-2`, and clean up afterwards. Never `pkill -f playwright`.
- A feature that adds or changes UI gets a spec. Billing and the model-backed assistant are not covered; `e2e/shell/ai-assistant.spec.ts` only checks Clip's visibility.

## CI

`.github/workflows/ci.yml` on push to `main` and every PR (ubuntu, Node 24, pnpm 10): `pnpm install --frozen-lockfile`, `pnpm typecheck`, fetch the docx corpus, `pnpm test`, `pnpm test:coverage`, `pnpm --filter @golemdocs/client build`. **CI does not run e2e**; the full e2e suite is a manual pre-release step.

## Deployment

One Worker serves API and client. `pnpm --filter @golemdocs/server deploy:prod` builds the client, writes `wrangler.generated.jsonc`, and runs `wrangler deploy --env=""` (production is the top-level config, at golemdocs.com). First-time setup (`cf:setup`: D1 `golemdocs-directory`, R2 `golemdocs-files`, Vectorize `golemdocs-docs`), secrets (`CF_API_TOKEN` and provider keys, [server/AUTH.md](../../server/AUTH.md)) and `cf:migrate` (D1 migrations in `server/migrations/directory/`) are in the README. `dev` and `local` environments exist so development never touches production; never set `DEV_USER` in production. `client/public/_redirects` redirects `/privacy` and `/terms` to `/home/...`.

## Changelog and release

- `CHANGELOG.md` is shown in the app (Help › What's New), so write for users. Any user-visible change (including home page copy) adds one line under `## <next version> - Unreleased` in `### Added`, `### Changed` or `### Fixed`. Never edit released versions; use `›` in menu paths.
- Release: replace `Unreleased` with the date, set `version` in the root and every package's `package.json` to match, and do not leave an empty `Unreleased` heading. Bump: major for breaking changes (files or saved data that no longer open), minor for features or notable behavior changes, patch for fixes only; while `0.x`, breaking changes bump minor.
- On deploy, run the full `pnpm e2e` first (background, output to a file, watched by a monitor that matches only `✘` result lines and ends on the script's last line, reproduce failures in an isolated second run), then release. Details are in AGENTS.md.

## Invariants and gotchas

- Do not start, restart or stop dev servers in the main checkout (worktrees may, on other ports). Do not use `git stash` in the main checkout.
- A static plus a dynamic import of the same module defeats chunk splitting.
- Editing app source during a full e2e run hot-reloads running pages, causing spurious failures.
- `wrangler.generated.jsonc` and `wrangler.local.json` are git-ignored; the committed config has `REPLACE_...` placeholders.
- The `docx` corpus and PDF corpus are not in git; some tests skip without them.

## Related docs

[Rendering](rendering.md), [Layout](layout.md), [Document model](document-model.md), [Collaboration](collaboration.md), [Server](server.md), [UI](ui.md), [Assistant](assistant.md); [Toolbar and file actions status](../actions-status.md); [Localization](../localization.md); README.md for local setup.
