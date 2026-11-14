# @golemdocs/script

Scripts for Golem Docs: small TypeScript or JavaScript files in a vault's `Scripts/` folder. A **producer** fills a live
block (a table, a value, a list); an **action** changes documents, by hand, from a button, when a document changes or on a
schedule. The plan is [docs/live-blocks.md](../docs/live-blocks.md) §8.

This package has no dependencies. It holds:

- `src/index.ts`, types only: what a script exports as `meta` (`ScriptMetaInput`) and the API its function is given
  (`ProducerApi`, `ActionApi`, `ScriptDocument`). A script may `import type` from it; type imports are deleted before it runs.
- `src/strip.ts` and `src/tokens.ts`: TypeScript to JavaScript by deleting the types, keeping every line's number.
- `src/link.ts`: a script and the scripts it imports (relative paths inside `Scripts/`) as one program of `data:` modules.
- `src/runtime.ts`: the code inside the sandbox's worker, which gives a script its API and asks the app for every read.
- `src/host.ts`: the app's side of a run: `meta`, approval, requests, time and size limits.
- `src/sandbox.ts` (a sandboxed frame and worker, in the browser) and `src/nodeChannel.ts` (a Node worker thread, for tests
  and `pnpm golem run`, not sandboxed).
- `src/grants.ts` and `src/fetch.ts`: what a person allowed a script, and the app's fetch for an action's sites.

The vault as scripts see it (notes as Markdown, editing documents through their formats) is in the client,
`client/src/scripts/`, since it needs the client's formats.

## A script

```ts
import type { ProducerApi, ScriptMetaInput } from '@golemdocs/script';

export const meta: ScriptMetaInput = { name: 'Reading list', reads: ['Books/'] };

export default async function (api: ProducerApi) {
  const books = await api.notes('Books/');
  return api.table(['Title', 'Rating'], books.map((b) => [b.title, b.fields.rating ?? '']));
}
```

Run one against a vault folder from the command line with `pnpm golem run Scripts/reading.ts --vault <folder>`.

## Tests

`pnpm --filter @golemdocs/script test`
