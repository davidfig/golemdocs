# Golem Docs

**One editor for every kind of document.** Open, edit and keep Word files, PDFs, spreadsheets, notes and drawings together, organized in folders on your computer.

[Open Golem Docs](https://golemdocs.com) · [Download for your computer](https://golemdocs.com/home/download) · [Why it's open source](https://golemdocs.com/home/open-source)

- **A real editor.** Pages that print the way they look, PDFs you can edit and fill in, Markdown notes, vector drawings, pictures and spreadsheets, all in one app. It opens Word, OpenDocument, PDF, Markdown, HTML, EPUB, CSV, SVG, images and ZIP archives, and stays fast with all of War and Peace on screen.
- **Your second brain, in plain files.** Notes link to each other with `[[wikilinks]]` that follow a rename, next to your Word files and PDFs. Every document is an ordinary file in a folder you choose, so an Obsidian vault opens as it is.
- **No ai inside, on purpose.** If you use an ai app (Claude, ChatGPT, Codex, Cursor...), point it at your folder and it works on the same files. Golem Docs shows its changes a few seconds later and keeps the earlier versions.
- **Free, with no account.** It runs in your browser and on Mac, Windows and Linux. $3 a month adds sync across devices, sharing and live editing together, and pays for the server.
- **Open source, all of it:** the editor, the server, and the libraries that read and write each format.

## How it's built

Text is drawn with WebGL (MSDF glyph atlases), so zooming stays sharp and large documents stay fast. Documents are saved in the browser with no account; signed in, they are saved to the account instead (the browser keeps a cache for speed and offline work). The desktop app keeps every document as a file in a folder on disk, in step with the account.

pnpm workspace:

| Package | What it is |
| --- | --- |
| `client` | The app: Vite + WebGL renderer, menus and toolbars, browser storage |
| `server` | Cloudflare Worker: sign-in, cloud documents (D1 for the catalogue, R2 for the files), sharing, and multiplayer rooms (a Durable Object per document) |
| `desktop` | Tauri shell for Mac, Windows and Linux: the web app in a native window, with the documents folder kept in sync |
| `docx`, `odt`, `pdf` | Readers and writers for Word, OpenDocument and PDF |
| `layout`, `editor`, `ops` | Page layout, editing, and the operations that merge live edits |

## License

| Part | License |
| --- | --- |
| The app: `client`, `server`, `desktop`, and everything else not listed below | [AGPL-3.0](LICENSE) |
| The libraries: `docx`, `layout`, `editor`, `ops`, `odt`, `pdf` | MIT (each package's `LICENSE`) |

Fonts, spelling dictionaries and the PDF font metrics keep their own licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The Golem Docs name and logo aren't covered by these licenses: see [TRADEMARKS.md](TRADEMARKS.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Run it locally

Requirements: Node 22.13 or newer, and pnpm (`corepack enable` gets you one).

```sh
pnpm install
pnpm dev
```

Open <http://localhost:5173>. `pnpm dev` is the one command for local testing. It creates `server/.dev.vars` on first run, applies the database migrations, then starts the client (Vite, port 5173) and the server (`wrangler dev`, port 3001) with prefixed output. Ctrl-C stops both, and if either one crashes the other is stopped too.

The editor on its own needs nothing else (`pnpm dev:client` runs just that): documents save themselves in this browser as you edit (IndexedDB, see File ▸ Open Recent). The font atlases are committed, so there is nothing to generate.

### Cloud services in local development

The server has three Cloudflare environments in `server/wrangler.jsonc`, and local development never uses production's:

| Environment | Used by | D1 and R2 | Cloud documents |
| --- | --- | --- | --- |
| `dev` | `pnpm dev` (once set up) | The real **dev** database and bucket (`golemdocs-directory-dev`, `golemdocs-files-dev`). The Worker runs on your machine; only D1 and R2 are remote. | On. Per-user databases are named `golemdocs-dev-user-<id>`. |
| `local` | `pnpm dev --local`, or `pnpm dev` before dev is set up | Simulated on your machine (`server/.wrangler/`); works offline. | On, kept in the simulated directory database (per-user tables) instead of per-user databases. Sharing and multiplayer work too. |
| production | `pnpm --filter @golemdocs/server deploy:prod` only | `golemdocs-directory`, `golemdocs-files`, `golemdocs-user-<id>` | On |

Set up the dev environment once:

1. `pnpm --filter @golemdocs/server exec wrangler login`, so wrangler can reach your dev resources.
2. `pnpm --filter @golemdocs/server cf:setup:dev` creates the dev D1 database and R2 bucket.
3. Copy `server/wrangler.local.example.json` to `server/wrangler.local.json` (git-ignored) and fill in `DIRECTORY_DEV_ID` with the printed database id and `ACCOUNT_ID` with your Cloudflare account id. `server/wrangler.jsonc` keeps `REPLACE_…` placeholders for these; the server's scripts merge your values into a git-ignored `wrangler.generated.jsonc` before each wrangler call.
4. Create an API token with D1 Edit permission and put it in `server/.dev.vars` as `CF_API_TOKEN`. The Worker uses it to create and query the per-user databases, which a Worker can't bind at deploy time. This is separate from the `wrangler login` credential.

After that, `pnpm dev` uses the dev resources on its own and applies the dev migrations on each start (`pnpm dev --local` forces the offline mode). It says which mode it chose when it starts.

Other things `server/.dev.vars` controls:

| Setting | Effect |
| --- | --- |
| `DEV_USER=you@example.com` | The API treats you as signed in, with no provider needed. Local development only; the first-run copy has it set. |
| Provider keys (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and so on) | Real sign-in buttons. Register `http://localhost:5173/api/auth/callback/<provider>` as the redirect URI. Apple doesn't allow localhost, so test it on a deployed https domain. Setup for each provider is in [server/AUTH.md](server/AUTH.md). |

### Trying multiplayer locally

`pnpm dev` works offline with no Cloudflare account (cloud documents, sharing and rooms are all simulated). To see two people editing:

1. Open <http://localhost:5173> and choose **Sign in ▸ Dev User**, then File ▸ Save to Cloud.
2. Open the same document in a second tab: the first tab hands the document over, and both edit live with carets.
3. To try sharing, open a private window and go to `http://localhost:5173/api/auth/start/dev?as=alice@example.com&return=/`. That signs that window in as a second user. Back in the first window, File ▸ Share… with `alice@example.com`; the document appears under "Shared with me" on Alice's dashboard.

### Where local state lives

- Saved documents: the browser's IndexedDB (DevTools ▸ Application ▸ IndexedDB ▸ `word`). Each copy has an `owner` (the account's user id) once it belongs to an account; signing in gives the ones without one to that account, and signing out deletes the account's copies. The last signed-in account is remembered in `localStorage` (`golem.account`) so the app still shows its documents offline.
- Thumbnails for the dashboard (File ▸ Open): rendered from page 1 on every save and kept in IndexedDB next to the document; cloud documents carry theirs (uploaded with the document, fetched only when their card scrolls into view).
- Server state in `local` mode: `server/.wrangler/`. Delete it to reset the simulated D1, R2 and sessions. In `dev` mode the data is in your dev Cloudflare resources (delete the `golemdocs-dev-user-…` databases and empty the bucket from the dashboard to reset).

### Handy for development

- `?doc=` in the URL opens a document (`welcome`, `fonts`, `war-and-peace`, `local:<id>`, `cloud:<id>`).
- `pnpm --filter @golemdocs/docx corpus` downloads the .docx round-trip corpus; the dev server then lists it under File ▸ Open Sample.
- `pnpm fonts` regenerates the font atlases (needs `cmake`, FreeType and libpng; see `scripts/fonts/generate.ts`).

## Checks

```sh
pnpm typecheck
pnpm test
```

## Deploying to Cloudflare

One Worker serves both the API and the built client. The steps, in order:

1. `pnpm --filter @golemdocs/server cf:setup` creates the `golemdocs-directory` D1 database and the `golemdocs-files` R2 bucket. Put the printed database id and your account id in `server/wrangler.local.json` as `DIRECTORY_ID` and `ACCOUNT_ID` (production).
2. Set secrets with `pnpm --filter @golemdocs/server exec wrangler secret put <NAME> --env=""`: `CF_API_TOKEN` (D1 Edit) plus each sign-in provider's values ([server/AUTH.md](server/AUTH.md)).
3. `pnpm --filter @golemdocs/server cf:migrate` applies the directory migrations to the remote database.
4. `pnpm --filter @golemdocs/server deploy:prod` builds the client and deploys.

The `--env=""` in the scripts selects the production (top-level) config. Never set `DEV_USER` in production.

## Troubleshooting

- **"cloud storage is not configured"**: `CF_API_TOKEN` (or the account id in `wrangler.local.json`) is missing. Sign-in still works without it.
- **`pnpm dev` fails applying dev migrations**: not logged in to Cloudflare or offline; run `wrangler login`, or use `pnpm dev --local`.
- **"Sign-in is unavailable"**: no provider has all of its values set.
- **Type errors mentioning `@golemdocs/ops`**: run `pnpm install` so the workspace packages are linked.
