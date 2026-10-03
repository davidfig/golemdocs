# Agent Instructions

## Never look up `@golemdocs/*` on npm

`@golemdocs/*` packages are private workspace packages and are **not on npm**. Do not open npmjs.com or the registry in any browser, `WebFetch`, `curl`, `npm view`, `npm info` or `npm login`/`whoami`: the page doesn't exist and just redirects to a login screen you cannot pass. Everything you would look up is local: read the package's own `package.json` (`name`, `version`, `description`) and its `README.md` or `src/index.ts`.

## Dependencies

Prefer fewer dependencies. Default to hand-coding functionality rather than pulling in a package.

- **Always ask before adding a dependency.** This applies to every `package.json` in the workspace (root and all packages), and to both `dependencies` and `devDependencies`. Do not run `pnpm add` or edit a `package.json` to add a package without explicit approval.
- Only propose a dependency when it adds tremendous value—for example, it solves a genuinely hard problem (complex format parsing, cryptography, font/image processing) that would be large, risky, or error-prone to write by hand.
- When proposing one, explain:
  - what the package is and what problem it solves here
  - why hand-coding it isn't reasonable (rough size/complexity of a hand-rolled version)
  - its footprint: bundle size, transitive dependencies, and maintenance status
- If a small helper, utility, or wrapper would do the job, write it instead.
- Moving code between existing workspace packages (`@golemdocs/*`) is not adding a dependency and doesn't need approval.

## Bundle size and lazy loading

Load only the code a session needs. Every document format, every large panel and every font face is fetched when first used, not up front.

- **Split threshold:** put code in its own lazily loaded chunk only if it is **about 20 kB or more minified** (JS plus its CSS) **and** most sessions never need it. Below that, a chunk's request round trip costs more than it saves: keep it static, next to whatever uses it.
- **One feature, one chunk:** code that is always needed together (a format's reader, writer and helpers) goes behind a single entry module that is only ever `import()`ed, so it builds as one chunk rather than several tiny ones. Never import the same module both statically and dynamically: the static import defeats the split.
- **Document formats:** each is a `FormatHandler` in `client/src/formats/handlers/`, registered in `HANDLERS` (`formats/convert.ts`). The always-present ones (Word, plain text) are a few hundred bytes of glue, so they are imported statically; anything larger is `import()`ed there.
- **Fonts:** never load a face's metrics or atlas until a document uses it (`FontSet.ensure`). No font data goes in a JS bundle.
- **Font pages:** a family's core atlas holds the characters nearly every document uses (`scripts/fonts/charset.txt`); every other character its font has goes in an extra page (`<id>-extra`, `withExtras` in `scripts/fonts/sources.ts`), and CJK languages are pages too. All are one mechanism: a manifest family with `page: { group, order, coverage }`, loaded by `FontSet.ensurePages` only for a document that uses a character on it, and drawn through `RunStyle.fallbacks`. Don't widen a core charset or add a second path for rare glyphs: add pages.
- **Check your work:** run `pnpm --filter @golemdocs/client build` and read the chunk list. The layout worker (`layoutWorker-*.js`) and the main `index-*.js` should not grow because of a new format, and a new chunk under ~20 kB means it should be merged back in.

## Tests

Add tests where reasonable. New logic, a bug fix or a changed behavior that can be exercised without a browser gets a test in the package's `test/` folder (`client/test/*.test.ts` for the client), next to the ones for the same area. Prefer testing the pure logic (readers, converters, layout, formatting) over DOM code. Run `pnpm --filter @golemdocs/client test` before finishing.

**End-to-end tests** (`e2e/`, Playwright, `pnpm e2e`) drive the real app in Chromium for what only a user does: menus, dialogs, toolbars, keystrokes, mouse, clipboard, downloads, collaboration. A feature that adds or changes UI gets a spec in the matching `e2e/<area>/` folder. They are slow, so during ordinary development run **only the specs you added or changed** (`pnpm e2e <path>`), never the full suite; run the full suite only when the user asks, and before every release (see Changelog) unless the user says to skip it. They run their own client and server on :5273 and :3101 (never the `pnpm dev` ones) against a throwaway local database. The editor is a canvas, so read the document through `app.text()` and the `window` hooks, or by downloading a file; see `e2e/fixtures.ts`. To run a second e2e run alongside another (say, just the specs that failed in a full run), give it its own servers and state through `e2e/ports.ts`: `E2E_CLIENT_PORT=5274 E2E_API_PORT=3102 E2E_STATE=e2e/.state-2 pnpm e2e <paths> --workers=2 --output=e2e/.results-2` (and delete `e2e/.state-2`, `e2e/.results-2` afterwards). Give parallel runs their own `--output=<dir>`, and never `pkill -f playwright` (it kills the servers). Tag a test `{ tag: '@heavy' }` if it only passes reliably when the machine is idle (drag and drop, frame timing, long waits); `pnpm e2e` runs those in a second pass with fewer workers and a retry. Every test gets one retry (a pass on the retry is reported as flaky), and the default is a third of the cores as workers: set `E2E_WORKERS=n` to change it. Billing and the assistant are not covered yet.

## AI assistant parity

Every feature a user can do should have an equivalent assistant tool, so the AI can do whatever the menus and toolbars can. When you add or change a user-visible feature, add or update its tool in the same change:

- Describe it in `server/src/assistantTools.ts` (name, description, parameters). The server only describes tools; names and arguments must match what the page runs.
- Implement it where the work happens: document edits in `client/src/layout/agentTools.ts` (run in the layout worker), tools that act on the app rather than the text in `APP_TOOLS` in `client/src/main.ts`. Reuse the same function the UI calls so the two cannot drift.
- Add the tool to `EDITS` (`client/src/assistant/index.ts`) if it is an undoable change to the document, and give it a progress note (`assistant.tool.*`, all languages).
- Mention the capability in the system prompt's list of what the AI can do, and test the tool (`client/test/agentTools.test.ts` for worker tools).
- If a feature truly cannot be done by a tool (it is purely visual or needs the user's own device), say so in the change instead of silently skipping it.

## Marketing clip

The home page's performance section plays `client/public/home/war-and-peace.webm`, a recording of the real app. When the app's look changes in a way the clip shows (toolbars, menus, the status bar, Page Grid, the mascot), re-record it with `pnpm record:home` (`scripts/marketing/record-war-and-peace.ts`). It needs the user's dev server on :5173 and takes about a minute; see the script's header for options.

## Settings that follow the account

A setting kept in browser storage is either per device or follows the person (see `client/src/settingsSync.ts`). When you add a persisted setting, decide which: a preference (a choice of look, language, behavior, view) goes in `SYNCED_KEYS` so every computer shows it; anything tied to this screen (sizes, positions, panel or toolbar layout, per-document zoom or scroll) and notices already dismissed stay out. A phone's settings are separate from a computer's, so a synced setting needs a sensible default on both.

## Welcome document

The welcome documents (`client/src/layout/welcome/*.md`) must show no spelling errors. After you edit the English one, spell check it (F7, or run `pnpm --filter @golemdocs/client test`: a test fails on any misspelled word). Then, for each flagged word, confirm it is actually spelled correctly (a name, a format, a key) and add it to `client/src/spelling/appWords.ts`. Fix real typos in the document instead.

## Consistent UI

The app should look and behave the same everywhere: the same buttons, icons, fonts, sizes, spacing and colors for the same job. Keep UI elements centralized so they cannot drift apart.

- **Reuse before you build.** Before writing a button, title bar, icon or dialog, look for the shared one and use it: `dialogTitleBar`, `showDialog` (`ui/popup.ts`), `iconButton` and `CLOSE_ICON` (`ui/dom.ts`), the `wm-button` class, and the color and font variables (`--wm-*`).
- **Centralize what you would otherwise copy.** If two places need the same element and no shared one exists, make it shared (a helper in `ui/`, a class in `ui.css`) and move the existing copies onto it in the same change, rather than adding a third.
- **Draw icons, don't type them.** Use an SVG (`iconButton`) rather than a character such as `×` or `▸`: characters are placed differently by each font, so they don't line up with each other.

## Localization

Every user-visible string goes through `t('area.key')` (`client/src/i18n`), never an inline literal. Add the English to `client/src/i18n/en/` and call `t()` inside functions, not at module top level. Adding an English key makes the translation-completeness test fail until every language in `client/src/i18n/locales/` has it. See `docs/localization.md` for the conventions and how to add a language.

**The marketing site is translated too.** The home page (`client/public/home/`) is generated in every language the app supports from `client/home/template.html` and `client/home/locales/<tag>.json` (`pnpm build:home`). When you add a language to the app, also add `client/home/locales/<tag>.json`, run `pnpm build:home`, and add the new page to `client/public/sitemap.xml`; the `home` test fails until you do. When you change English marketing copy, update every language's file too.

**Adding a language** also means adding its spelling dictionary and checking its grammar. Follow *Spelling dictionaries* in `docs/localization.md`: put the Hunspell `.aff`/`.dic` pair and its license in `client/public/dictionaries/`, register it in `client/src/spelling/languages.ts`, and add a test. The grammar checker (`client/src/spelling/grammar.ts`) is English only: add rules for the new language (and let the layout worker turn them on for it), or say in the change that it has none. A language with no usable Hunspell dictionary (such as Chinese, Japanese or Korean) is left unchecked, so it shows no squiggles. Spell check the language's welcome document, and add its properly spelled words to `client/src/spelling/appWords.ts`.

## Dev servers

The user starts any dev server you need (`pnpm dev`, which runs Vite on :5173 and the server on :3001). Don't start, restart or stop one yourself in the main checkout: duplicate processes pile up and fight over the ports. If you need one running, or it looks down (for example `/api` calls returning 500 from the Vite proxy), ask the user.

**Exception: worktrees.** In a git worktree you may run and stop your own dev server, but never on the normal ports (5173, 3001). Pick other ports, pass them to both the client and the server, and stop the processes when you are done.

## Git stash

Never use `git stash` (including `git stash pop`, `apply` or `drop`) when working in the main checkout. Other agents are likely running there against the same working tree, and stashing sweeps up their uncommitted changes and can break their work. To set changes aside, commit them or copy the affected files instead.

**Exception: worktrees.** A git worktree has its own working tree, so no other agent shares your uncommitted changes there. Stashing is fine, but note that the stash list is shared across all worktrees of the repo: only pop or drop a stash you created yourself.

## Changelog

`CHANGELOG.md` (repository root) is shown in the app under Help ▸ What's New. When you make a user-visible change (a feature, a behavior change or a bug fix), add one line for it under the `## <version> - Unreleased` heading (create it above the latest release if there is none), in an `### Added`, `### Changed` or `### Fixed` group, in the same change. Changes to the home page (`client/public/home/`) count too, even when they only describe an existing feature. Write for users, not developers; skip refactors, tests and tooling. Write menu paths with `›` (File › Open), not `▸`: no bundled font has `▸`, so it does not render in the app. Never edit released versions. To release, replace `Unreleased` with the date (`## 0.1.0 - 2026-10-01`), set the `version` in every `package.json` to match, and leave no `Unreleased` heading until the next change.

**On deploy, run the full e2e suite (`pnpm e2e`) first, unless the user says otherwise, as follows, then do this release step yourself.** Start the full run in the background with its output going to a file (never piped through `tail`), and watch that file for failures (a Monitor on `✘` lines works). Do not wait for it to finish: as each failure appears, start a second, isolated run of just that spec (own ports and state, see the Tests section: `E2E_CLIENT_PORT=5274 E2E_API_PORT=3102 E2E_STATE=e2e/.state-2 pnpm e2e <spec> --workers=2 --output=e2e/.results-2`) to reproduce and fix it while the main run carries on. Never stop the main run to free the ports. A failure that does not reproduce alone is flaky from load: say so. Editing app source while the main run is going hot-reloads the pages of the tests running at that moment, so those tests may fail spuriously: re-run the specs that were in flight (in the side run) before counting them as failures. Release only when the main run's failures are all fixed (re-run the fixed specs) or reported to the user. **Then the release step:** turn the latest What's New entry (the `Unreleased` heading) into the release, dated today, and update the `version` in every `package.json` to match. You decide the semver bump by reading the changelog entries: **major** for breaking changes (e.g. files or saved data that no longer open), **minor** for new features or notable behavior changes, **patch** when it is only bug fixes. While the version is `0.x`, breaking changes bump minor rather than major. State the bump you chose and why in your reply. Do **not** add an empty `Unreleased` heading after releasing: the app shows the changelog as is, so an empty entry would appear in What's New. The next user-visible change creates the `## <next version> - Unreleased` heading itself.
