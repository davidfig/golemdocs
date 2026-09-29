# Golem Docs

A Word-style editor for the browser. Text is drawn with WebGL (MSDF glyph atlases), so zooming stays sharp and large documents stay fast. Documents are saved in the browser with no account; signing in is only needed to keep a copy in the cloud.

pnpm workspace:

| Package | What it is |
| --- | --- |
| `client` | The app: Vite + WebGL renderer, menus and toolbars, browser storage |
| `server` | Cloudflare Worker: sign-in, plus cloud documents (D1 for the catalogue, R2 for the files) |
| `docx`, `layout`, `editor`, `ops`, `pdf` | Format, layout, editing and collaboration libraries used by the client |

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
| `dev` | `pnpm dev` (once set up) | The real **dev** database and bucket (`word-directory-dev`, `word-files-dev`). The Worker runs on your machine; only D1 and R2 are remote. | On. Per-user databases are named `word-dev-user-<id>`. |
| `local` | `pnpm dev --local`, or `pnpm dev` before dev is set up | Simulated on your machine (`server/.wrangler/`); works offline. | Off (they need the real Cloudflare API). Sign-in still works. |
| production | `pnpm --filter @word/server deploy` only | `word-directory`, `word-files`, `word-user-<id>` | On |

Set up the dev environment once:

1. `pnpm --filter @word/server exec wrangler login`, so wrangler can reach your dev resources.
2. `pnpm --filter @word/server cf:setup:dev` creates the dev D1 database and R2 bucket.
3. Paste the printed database id and your Cloudflare account id into `env.dev` in `server/wrangler.jsonc`.
4. Create an API token with D1 Edit permission and put it in `server/.dev.vars` as `CF_API_TOKEN`. The Worker uses it to create and query the per-user databases, which a Worker can't bind at deploy time. This is separate from the `wrangler login` credential.

After that, `pnpm dev` uses the dev resources on its own and applies the dev migrations on each start (`pnpm dev --local` forces the offline mode). It says which mode it chose when it starts.

Other things `server/.dev.vars` controls:

| Setting | Effect |
| --- | --- |
| `DEV_USER=you@example.com` | The API treats you as signed in, with no provider needed. Local development only; the first-run copy has it set. |
| Provider keys (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and so on) | Real sign-in buttons. Register `http://localhost:5173/api/auth/callback/<provider>` as the redirect URI. Apple doesn't allow localhost, so test it on a deployed https domain. Setup for each provider is in [server/AUTH.md](server/AUTH.md). |

### Where local state lives

- Saved documents: the browser's IndexedDB (DevTools ▸ Application ▸ IndexedDB ▸ `word`).
- Thumbnails for the dashboard (File ▸ Dashboard): rendered from page 1 on every save and kept in IndexedDB next to the document; cloud documents carry theirs (uploaded with the document, fetched only when their card scrolls into view).
- Server state in `local` mode: `server/.wrangler/`. Delete it to reset the simulated D1, R2 and sessions. In `dev` mode the data is in your dev Cloudflare resources (delete the `word-dev-user-…` databases and empty the bucket from the dashboard to reset).

### Handy for development

- `?doc=` in the URL opens a document (`welcome`, `fonts`, `war-and-peace`, `local:<id>`, `cloud:<id>`); `?room=<name>` opens a collaboration room shared between this browser's tabs.
- `pnpm --filter @word/docx corpus` downloads the .docx round-trip corpus; the dev server then lists it under File ▸ Open Sample.
- `pnpm fonts` regenerates the font atlases (needs `cmake`, FreeType and libpng; see `scripts/fonts/generate.ts`).

## Checks

```sh
pnpm typecheck
pnpm test
```

## Deploying to Cloudflare

One Worker serves both the API and the built client. The steps, in order:

1. `pnpm --filter @word/server cf:setup` creates the `word-directory` D1 database and the `word-files` R2 bucket. Paste the printed database id and your account id into the top level of `server/wrangler.jsonc` (production).
2. Set secrets with `pnpm --filter @word/server exec wrangler secret put <NAME> --env=""`: `CF_API_TOKEN` (D1 Edit) plus each sign-in provider's values ([server/AUTH.md](server/AUTH.md)).
3. `pnpm --filter @word/server cf:migrate` applies the directory migrations to the remote database.
4. `pnpm --filter @word/server deploy` builds the client and deploys.

The `--env=""` in the scripts selects the production (top-level) config. Never set `DEV_USER` in production.

## Troubleshooting

- **"cloud storage is off in local-only mode"**: you're running `pnpm dev --local`, or the dev environment isn't set up yet. See the setup steps above.
- **"cloud storage is not configured"**: `CF_API_TOKEN` (or the account id in `env.dev`) is missing. Sign-in still works without it.
- **`pnpm dev` fails applying dev migrations**: not logged in to Cloudflare or offline; run `wrangler login`, or use `pnpm dev --local`.
- **"Sign-in is unavailable"**: no provider has all of its values set.
- **Type errors mentioning `@word/ops`**: run `pnpm install` so the workspace packages are linked.
