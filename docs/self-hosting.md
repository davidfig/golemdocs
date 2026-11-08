# Self-hosting Golem Docs on Cloudflare

The website has a shorter, translated version of this guide: [golemdocs.com/home/self-host](https://golemdocs.com/home/self-host) (`client/home/pages/self-host.html`). Keep the two in step.

Golem Docs is free to use with no server at all: documents stay on your device. A server adds sync between devices, sharing, live editing together and version history in the account. golemdocs.com runs one for $3 a month. You can also run your own on your own Cloudflare account, so the files and the account data are yours.

The server is one Cloudflare Worker. It also serves the app itself, so your address *is* Golem Docs for the people you let in. It uses:

| Cloudflare product | For |
| --- | --- |
| Workers | the app's files and the API |
| D1 (one database, `golemdocs-directory`) | accounts, sessions, sharing, and each person's list of documents and folders |
| R2 (one bucket, `golemdocs-files`) | the documents, their pictures and their history |
| Durable Objects (SQLite) | a room for each document while people edit it together |

**Cloudflare only, for now.** The server is built on Cloudflare's Workers, D1, R2 and Durable Objects. Cloudflare's open-source runtime, workerd, could run it elsewhere, but it has no D1 or R2, so that would need adapters for both (SQLite, and a folder or any S3-compatible storage). Miniflare, which `pnpm dev --local` uses, has them all but is for development and testing only. If someone asks to host it without Cloudflare, David will work out a plan for it.

## What it costs

For a household it can cost nothing, or about $5 a month for more headroom. The figures below are from Cloudflare's pricing pages, checked on 2026-11-08.

| | Workers Free | Workers Paid ($5 a month minimum) |
| --- | --- | --- |
| API requests (opening, saving, listing; the app's own files are free and unlimited) | 100,000 a day | 10 million a month, then $0.30 per million |
| CPU time | 10 ms per request | 30 million ms a month, then $0.02 per million ms |
| D1 database | 500 MB at most, 5 million rows read and 100,000 written a day | 10 GB at most, 25 billion rows read and 50 million written a month |
| Durable Objects (live editing) | 100,000 requests a day | 1 million a month, then $0.15 per million |
| R2 file storage | 10 GB free, then $0.015 per GB a month, on either plan | the same |
| R2 writes (Class A) | 1 million a month free, then $4.50 per million, on either plan | the same |

Incoming live-editing messages count as one request per 20. Each account may keep up to 25 GB (`ACCOUNT_STORAGE_BYTES` in `ops/src/accountStorage.ts`), so four people who fill their accounts store 100 GB: about $1.35 a month in R2 on top of the plan.

**Which plan.** On the free plan, a limit that runs out makes requests fail until it resets at midnight UTC, rather than charging more. The one most likely to matter is CPU: 10 ms per request is tight for building the search index of a long document or turning a long live-editing session into a saved file, so those may fail on Free. If anything fails for no clear reason, move to Workers Paid. Cloudflare may ask for a payment method before R2 can be turned on, even within its free storage.

Check Cloudflare's [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/) ([limits](https://developers.cloudflare.com/d1/platform/limits/)), [R2](https://developers.cloudflare.com/r2/pricing/) and [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) pricing for today's figures.

## What you need

- A Cloudflare account. A domain on it is optional: without one, the server is at `golemdocs.<your-subdomain>.workers.dev`.
- Node 22.13 or newer, and pnpm (`corepack enable`).
- A sign-in provider app: GitHub is the quickest to set up (below). Google, Microsoft and Apple work too ([server/AUTH.md](../server/AUTH.md)).

## Set it up

All the commands run from the repository's root folder.

1. **Get the code and sign in to Cloudflare.**

   ```sh
   git clone https://github.com/davidfig/golemdocs.git
   cd golemdocs
   pnpm install
   pnpm --filter @golemdocs/server exec wrangler login
   ```

2. **Create the database and the bucket.** R2 has to be turned on in the Cloudflare dashboard first (R2 Object Storage); Cloudflare may ask for a payment method even within the free allowance. Then run this, which prints the database's id:

   ```sh
   pnpm --filter @golemdocs/server cf:setup
   ```

3. **Say which account, database and address.** Copy `server/wrangler.local.example.json` to `server/wrangler.local.json` (it is git-ignored) and fill in:

   | Key | Value |
   | --- | --- |
   | `ACCOUNT_ID` | your Cloudflare account id (`pnpm --filter @golemdocs/server exec wrangler whoami`) |
   | `DIRECTORY_ID` | the database id `cf:setup` printed |
   | `DIRECTORY_DEV_ID` | leave empty |
   | `DOMAIN` | your domain on this Cloudflare account (`docs.example.com`), or `workers.dev` to use the workers.dev address |

4. **Create the tables, then deploy.** The deploy builds the app and uploads it with the server.

   ```sh
   pnpm --filter @golemdocs/server cf:migrate
   pnpm --filter @golemdocs/server deploy:prod
   ```

   It prints the address the server is at.

5. **Make a GitHub sign-in app.** On GitHub, open Settings › Developer settings › OAuth Apps › New OAuth App. Use your server's address as the homepage URL and `https://<your address>/api/auth/callback/github` as the callback URL. Generate a client secret.

6. **Set the server's settings.** Each command asks for the value. Run them from the `server` folder:

   ```sh
   cd server
   pnpm exec wrangler secret put SINGLE_DATABASE --env=""
   pnpm exec wrangler secret put ALLOWED_EMAILS --env=""
   pnpm exec wrangler secret put ADMIN_EMAILS --env=""
   pnpm exec wrangler secret put GITHUB_CLIENT_ID --env=""
   pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env=""
   ```

   | Setting | Value |
   | --- | --- |
   | `SINGLE_DATABASE` | `true`: everyone's list of documents is kept in the one database, so the server needs no Cloudflare API token |
   | `ALLOWED_EMAILS` | who may sign in, comma-separated: whole addresses (`me@example.com`) or a whole domain (`@example.com`). **Set this**, or anyone who finds the address can sign up and store files at your expense |
   | `ADMIN_EMAILS` | your own address. Admins may always sign in and read the feedback people send (Help › Send Feedback) |

7. **Open your address and sign in with GitHub.** That's it: the documents you make while signed in are kept on your server.

## Optional settings

Set these the same way (`wrangler secret put <NAME> --env=""` in `server`).

**Links.** The app's links go to golemdocs.com unless you set your own. Each takes a web address; `LINK_SUPPORT` also takes an email address.

| Setting | Where it shows |
| --- | --- |
| `LINK_WEBSITE` | Help › Golem Docs Website, and the welcome document's link to the website |
| `LINK_PRICING` | the welcome document's pricing link |
| `LINK_SUPPORT` | the welcome document's email address for help |
| `LINK_PRIVACY` | Help › Privacy Policy, instead of golemdocs.com's built-in one |
| `LINK_TERMS` | Help › Terms of Service, instead of golemdocs.com's built-in one |

**More sign-in providers.** Google, Microsoft and Apple: see [server/AUTH.md](../server/AUTH.md). Each is offered once all its settings are there.

## Keep it up to date

```sh
git pull
pnpm install
pnpm --filter @golemdocs/server cf:migrate
pnpm --filter @golemdocs/server deploy:prod
```

Read [What's New](../CHANGELOG.md) first. A release that changes how files or accounts are stored says so there.

## Who can get in

- Only the addresses in `ALLOWED_EMAILS` (and `ADMIN_EMAILS`) can sign in, and only if their sign-in provider has verified that address. Someone who isn't on the list is told so and nothing about them is kept.
- Taking someone off the list keeps them out from their next sign-in. To sign them out now, delete their sessions:

  ```sh
  pnpm --filter @golemdocs/server exec wrangler d1 execute golemdocs-directory --remote --command "DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM identities WHERE email = 'them@example.com')"
  ```

- The people on your server can share documents with each other, but not with golemdocs.com accounts or another server.

## What is different from golemdocs.com

- **Use it in the browser.** The desktop and phone apps connect only to golemdocs.com for now. The desktop app's documents folder doesn't sync with your server.
- **Nothing is sold.** Without the Polar settings (`POLAR_*`), File › Subscribe isn't shown and everyone signed in gets sync, sharing and live editing.
- **The website is golemdocs.com's.** `/home` (and `/privacy`, `/terms`) on your address are copies of golemdocs.com's pages. The welcome document's words are the same too; only its links follow your settings.
- **No billing panel.** The admin panel's Cloudflare billing figures need a `CF_API_TOKEN` with Billing Read permission. Everything else works without one.

## If you change the code

The app and the server are under the [AGPL-3.0](../LICENSE): if you run a changed version for other people, offer them its source. The Golem Docs name and logo have their own rules: see [TRADEMARKS.md](../TRADEMARKS.md).

## How it works

`SINGLE_DATABASE=true` keeps each person's catalogue (their documents, folders, settings, versions and trash) as tables named `user_<id>_…` in the directory database, the way `pnpm dev --local` does. golemdocs.com instead gives each person a D1 database of their own, created through Cloudflare's API. See [Server](architecture/server.md#directory-d1-vs-per-user-d1). The page asks `GET /api/site` for the links and whether the server sells the subscription (`server/src/site.ts`, `client/src/site.ts`).
