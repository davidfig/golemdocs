# Contributing

Thanks for wanting to help. Golem Docs is maintained by one person, so the process is kept small.

## Issues

Bug reports and feature ideas are welcome as GitHub issues. For a bug, include what you did, what you expected and what happened, plus the file if it's a document that opens wrong (only if you're happy for it to be public).

**Security problems:** don't open a public issue. Use *Report a vulnerability* on the repository's Security tab.

## Pull requests

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach before you spend time on it. A pull request that arrives without one may be closed.
2. **Sign the CLA.** On your first pull request the CLA bot asks you to agree to the [Contributor License Agreement](CLA.md) with a comment. You keep the copyright in your work; the CLA lets the project use it under any license, which keeps the hosted version and future licensing open.
3. **Follow the project's conventions.** [AGENTS.md](AGENTS.md) lists them (it's written for coding agents, but applies to people too): no new dependencies without asking, every user-visible string through `t()`, shared UI components, a `CHANGELOG.md` line for user-visible changes, and tests for new logic.
4. **Run the checks** before you push:

   ```sh
   pnpm typecheck
   pnpm test
   ```

   If you changed UI, run the end-to-end specs you added or touched with `pnpm e2e <path>`.

## Licenses of contributions

Your contribution is released under the license of the folder it's in: AGPL-3.0 for the app (`client`, `server`, `desktop`) and MIT for the libraries (`docx`, `layout`, `editor`, `ops`, `odt`, `pdf`). See the License section of the [README](README.md).
