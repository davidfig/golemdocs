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
