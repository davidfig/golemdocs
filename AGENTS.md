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
