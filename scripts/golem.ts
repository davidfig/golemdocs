// The `golem` command line (docs/live-blocks.md §8): `pnpm golem run Scripts/daily-note.ts --vault <folder>` runs a vault's
// script in Node, not sandboxed. See client/src/scripts/cli.ts.

// Loaded by a computed path: the client's code is typechecked with the client (it needs the bundler's types), not here.
const cli = (await import(String('../client/src/scripts/cli.ts'))) as { main(argv: string[], cwd: string): Promise<number> };

// pnpm runs this from the repository's top; paths given on the command line are from where it was typed.
process.exitCode = await cli.main(process.argv.slice(2), process.env.INIT_CWD ?? process.cwd());
