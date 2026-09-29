# Sign-in setup

Hand-rolled OAuth/OpenID Connect in `src/authRoutes.ts` and `src/providers.ts`. A provider shows up
only when all of its values are set, so set up as many or as few as you like.

**Redirect URI** for each provider: `https://<your-domain>/api/auth/callback/<provider>` where
`<provider>` is `google`, `microsoft`, `github` or `apple`. Locally (Vite proxies `/api`) use
`http://localhost:5173/api/auth/callback/<provider>`; Apple doesn't allow localhost.

| Provider | Create it in | Values |
| --- | --- | --- |
| Google | Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web application) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Microsoft | Entra admin center → App registrations → New (accounts in any org directory and personal Microsoft accounts; platform Web) → Certificates & secrets | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, optional `MICROSOFT_TENANT` var (default `common`) |
| GitHub | Settings → Developer settings → OAuth Apps (or a GitHub App) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Apple | Developer account → Identifiers: an App ID with Sign in with Apple, then a Services ID (its Return URL is the redirect URI, its domain must be verified); Keys: a key with Sign in with Apple | `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (the whole `.p8` file) |

Deployed: `pnpm exec wrangler secret put GOOGLE_CLIENT_ID` (and so on). Local: put them in `.dev.vars`.
Then apply the directory migrations: `pnpm --filter @word/server cf:migrate`.

## How it behaves

- Authorization-code flow with PKCE, a `state` and a `nonce` bound to a short-lived HttpOnly cookie.
- ID tokens are checked for issuer, audience, expiry and nonce. Their signatures aren't verified:
  they come straight from the provider's token endpoint over TLS, which OpenID Connect allows.
- Sessions are random tokens in an HttpOnly, SameSite=Lax cookie (30 days). Only the SHA-256 of the
  token is stored (`sessions` in the directory D1), so logout or deleting a row revokes it.
- One user can have several sign-in methods. A new provider joins an existing user only when both
  providers report the same **verified** email (Google, GitHub's verified primary, Apple). Microsoft
  never reports verification, so it never links by email.
- Apple's callback is a cross-site form POST, so its flow cookie is `SameSite=None; Secure` (https only).
- The Apple button is shown on iPhone, iPad and Mac only (`client/src/auth.ts`); the server still accepts it elsewhere.
- Writes to `/api/documents` are refused unless the `Origin` header is this site.

Not included: rate limiting on `/api/auth/*` (use a Cloudflare rate-limiting rule), account deletion,
unlinking a provider.
