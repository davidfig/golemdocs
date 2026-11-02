# Security policy

## Reporting a problem

Please report security problems privately, not in a public issue: use **Report a vulnerability** on the repository's Security tab. Include what an attacker could do, the steps or a file that shows it, and the version or commit you tested.

Golem Docs is maintained by one person, so replies are best effort, usually within a week. You'll hear when the report is confirmed and when a fix ships; tell me if you'd like credit in the changelog.

## What's covered

- The app at golemdocs.com and the desktop apps (`client`, `desktop`).
- The server (`server`): sign-in, cloud documents, sharing and multiplayer rooms.
- The libraries (`docx`, `layout`, `editor`, `ops`, `odt`, `pdf`), especially anything a crafted document can make them do: crashes, hangs, runaway memory, or script running in the page.

Fixes go into the latest release only.

## Please don't

- test against other people's accounts or documents on golemdocs.com; use your own account or a local copy (`pnpm dev --local`);
- run load or denial-of-service tests against golemdocs.com.
