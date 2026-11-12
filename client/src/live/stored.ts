// The page's entry to the live chunk (docs/live-blocks.md §6): fetched the first time a block is updated or a script runs.
// The update itself is in storedUpdate.ts, which the live worker also runs; this adds what only the page has.

export { isStoredDrawing, sourceBytes, sourceLookupOf, updateFromStored, updateStoredLive } from './storedUpdate.ts';
export type { DrawingOf } from './storedUpdate.ts';
// File › Live PDF Copy makes a new one (main.ts); this module is the live chunk's one entry, so it comes through here.
export { newLiveExport } from './pdfLive.ts';
// Scripts (docs/live-blocks.md §8) run from the same chunk: their blocks are live blocks.
export { ScriptRunner } from '../scripts/runner.ts';
export { sandboxChannel } from '../scripts/sandbox.ts';
export { resultOf } from './sources.ts';
