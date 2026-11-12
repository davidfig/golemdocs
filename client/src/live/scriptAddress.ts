// Whether a live source names a script (docs/live-blocks.md §8). Small and static, so the keeper can tell without loading
// the live chunk.

/** A .ts or .js file in the vault's `Scripts/` (a producer); `/Scripts/...` too. */
export const isScriptSource = (title: string): boolean => /^\/?Scripts\/(?:[^/]+\/)*[^/]+\.(?:ts|js|mts|mjs)$/i.test(title.trim());

/** A script source's vault path (`Scripts/reading-list.ts`). */
export const scriptPathOf = (title: string): string => title.trim().replace(/^\/+/, '');

/**
 * A button block's address, `@run:Scripts/daily-note.ts`: a block showing an action's name, whose card runs it (the note
 * holds no code). Its script's vault path, or null when the source is not one.
 */
export function buttonScript(source: string): string | null {
  const m = /^\s*@run:\s*(.+?)\s*$/i.exec(source);
  return m && isScriptSource(m[1]) ? scriptPathOf(m[1]) : null;
}
