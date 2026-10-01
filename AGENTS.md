# Agent Instructions

## Dependencies

Prefer fewer dependencies. Default to hand-coding functionality rather than pulling in a package.

- **Always ask before adding a dependency.** This applies to every `package.json` in the workspace (root and all packages), and to both `dependencies` and `devDependencies`. Do not run `pnpm add` or edit a `package.json` to add a package without explicit approval.
- Only propose a dependency when it adds tremendous value—for example, it solves a genuinely hard problem (complex format parsing, cryptography, font/image processing) that would be large, risky, or error-prone to write by hand.
- When proposing one, explain:
  - what the package is and what problem it solves here
  - why hand-coding it isn't reasonable (rough size/complexity of a hand-rolled version)
  - its footprint: bundle size, transitive dependencies, and maintenance status
- If a small helper, utility, or wrapper would do the job, write it instead.
- Moving code between existing workspace packages (`@word/*`) is not adding a dependency and doesn't need approval.

## Bundle size and lazy loading

Load only the code a session needs. Every document format, every large panel and every font face is fetched when first used, not up front.

- **Split threshold:** put code in its own lazily loaded chunk only if it is **about 20 kB or more minified** (JS plus its CSS) **and** most sessions never need it. Below that, a chunk's request round trip costs more than it saves: keep it static, next to whatever uses it.
- **One feature, one chunk:** code that is always needed together (a format's reader, writer and helpers) goes behind a single entry module that is only ever `import()`ed, so it builds as one chunk rather than several tiny ones. Never import the same module both statically and dynamically: the static import defeats the split.
- **Document formats:** each is a `FormatHandler` in `client/src/formats/handlers/`, registered in `HANDLERS` (`formats/convert.ts`). The always-present ones (Word, plain text) are a few hundred bytes of glue, so they are imported statically; anything larger is `import()`ed there.
- **Fonts:** never load a face's metrics or atlas until a document uses it (`FontSet.ensure`). No font data goes in a JS bundle.
- **Check your work:** run `pnpm --filter @word/client build` and read the chunk list. The layout worker (`layoutWorker-*.js`) and the main `index-*.js` should not grow because of a new format, and a new chunk under ~20 kB means it should be merged back in.

## Tests

Add tests where reasonable. New logic, a bug fix or a changed behavior that can be exercised without a browser gets a test in the package's `test/` folder (`client/test/*.test.ts` for the client), next to the ones for the same area. Prefer testing the pure logic (readers, converters, layout, formatting) over DOM code. Run `pnpm --filter @word/client test` before finishing.

**End-to-end tests** (`e2e/`, Playwright, `pnpm e2e`) drive the real app in Chromium for what only a user does: menus, dialogs, toolbars, keystrokes, mouse, clipboard, downloads, collaboration. A feature that adds or changes UI gets a spec in the matching `e2e/<area>/` folder. They run their own client and server on :5273 and :3101 (never the `pnpm dev` ones) against a throwaway local database. The editor is a canvas, so read the document through `app.text()` and the `window` hooks, or by downloading a file; see `e2e/fixtures.ts`. Give parallel runs their own `--output=<dir>`, and never `pkill -f playwright` (it kills the servers). Billing and the assistant are not covered yet.

## Localization

Every user-visible string goes through `t('area.key')` (`client/src/i18n`), never an inline literal. Add the English to `client/src/i18n/en/` and call `t()` inside functions, not at module top level. Adding an English key makes the translation-completeness test fail until every language in `client/src/i18n/locales/` has it. See `docs/localization.md` for the conventions and how to add a language.

**The marketing site is translated too.** The home page (`client/public/home/`) is generated in every language the app supports from `client/home/template.html` and `client/home/locales/<tag>.json` (`pnpm home`). When you add a language to the app, also add `client/home/locales/<tag>.json`, run `pnpm home`, and add the new page to `client/public/sitemap.xml`; the `home` test fails until you do. When you change English marketing copy, update every language's file too.

## Dev servers

The user starts any dev server you need (`pnpm dev`, which runs Vite on :5173 and the server on :3001). Don't start, restart or stop one yourself in the main checkout: duplicate processes pile up and fight over the ports. If you need one running, or it looks down (for example `/api` calls returning 500 from the Vite proxy), ask the user.

**Exception: worktrees.** In a git worktree you may run and stop your own dev server, but never on the normal ports (5173, 3001). Pick other ports, pass them to both the client and the server, and stop the processes when you are done.

## Git stash

Never use `git stash` (including `git stash pop`, `apply` or `drop`) when working in the main checkout. Other agents are likely running there against the same working tree, and stashing sweeps up their uncommitted changes and can break their work. To set changes aside, commit them or copy the affected files instead.

**Exception: worktrees.** A git worktree has its own working tree, so no other agent shares your uncommitted changes there. Stashing is fine, but note that the stash list is shared across all worktrees of the repo: only pop or drop a stash you created yourself.

## Changelog

`CHANGELOG.md` (repository root) is shown in the app under Help ▸ What's New. When you make a user-visible change (a feature, a behavior change or a bug fix), add one line for it under the `## <version> - Unreleased` heading, in an `### Added`, `### Changed` or `### Fixed` group, in the same change. Changes to the home page (`client/public/home/`) count too, even when they only describe an existing feature. Write for users, not developers; skip refactors, tests and tooling. Never edit released versions. To release, replace `Unreleased` with the date (`## 0.1.0 - 2026-10-01`), set the `version` in every `package.json` to match, and start a new `## <next version> - Unreleased` heading.

**On deploy, do this release step yourself:** turn the latest What's New entry (the `Unreleased` heading) into the release, dated today, and update the `version` in every `package.json` to match. You decide the semver bump by reading the changelog entries: **major** for breaking changes (e.g. files or saved data that no longer open), **minor** for new features or notable behavior changes, **patch** when it is only bug fixes. While the version is `0.x`, breaking changes bump minor rather than major. State the bump you chose and why in your reply. Then add the new `## <next version> - Unreleased` heading above it.
