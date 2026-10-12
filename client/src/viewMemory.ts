// Where each document was left: the scroll position, zoom, caret and selection, kept in this
// browser so reopening a document puts them back. Keyed by the document's source ("local:<id>", "cloud:<id>", ...),
// newest first, and capped so it never grows without bound.

const STORAGE_KEY = 'golemdocs.views';
export const MAX_VIEWS = 200;

/** The scroll position and zoom: the document point at the top-left of the window, and which view it was in. */
export interface SavedCamera {
  x: number;
  y: number;
  zoom: number;
  /** Flow (reflowed) or Print layout: a position in one means nothing in the other. */
  reflow: boolean;
}

/** A place in the text: a paragraph's index among the document's paragraphs, and an offset in it. */
export type TextPlace = [paragraph: number, offset: number];

/** Where the caret and selection were, as places in the text (so they survive a different window width, view or zoom). */
export interface SavedSelection {
  anchor: TextPlace;
  /** Where the caret is; the same as `anchor` with nothing selected. */
  focus: TextPlace;
}

/** Where a document was left. A part is missing when there was none to keep. */
export interface SavedView {
  camera?: SavedCamera;
  selection?: SavedSelection;
}

const numbers = (o: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]));
const isCamera = (v: unknown): v is SavedCamera => {
  const o = v as Record<string, unknown> | null;
  return !!o && numbers(o, ['x', 'y', 'zoom']) && (o.zoom as number) > 0 && typeof o.reflow === 'boolean';
};
const isPlace = (v: unknown): v is TextPlace => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0);
const isSelection = (v: unknown): v is SavedSelection => {
  const o = v as Record<string, unknown> | null;
  return !!o && isPlace(o.anchor) && isPlace(o.focus);
};
/** A stored view with only its valid parts, or null if none is. */
const cleanView = (v: unknown): SavedView | null => {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const view: SavedView = {};
  if (isCamera(o.camera)) view.camera = o.camera;
  if (isSelection(o.selection)) view.selection = { anchor: o.selection.anchor, focus: o.selection.focus };
  return view.camera || view.selection ? view : null;
};

/** The saved views, most recently left first. */
export function readViews(storage: Pick<Storage, 'getItem'> | null = safeStorage()): [string, SavedView][] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const rows: [string, SavedView][] = [];
    for (const row of parsed) {
      const view = Array.isArray(row) && typeof row[0] === 'string' ? cleanView(row[1]) : null;
      if (view) rows.push([(row as [string, unknown])[0], view]);
    }
    return rows.slice(0, MAX_VIEWS);
  } catch {
    return [];
  }
}

/** `views` with `doc`'s view put first (replacing any earlier one), keeping at most `max`. */
export function withView(views: readonly [string, SavedView][], doc: string, view: SavedView, max = MAX_VIEWS): [string, SavedView][] {
  return [[doc, view] as [string, SavedView], ...views.filter(([key]) => key !== doc)].slice(0, max);
}

export function loadView(doc: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): SavedView | null {
  return readViews(storage).find(([key]) => key === doc)?.[1] ?? null;
}

export function saveView(doc: string, view: SavedView, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(withView(readViews(storage), doc, view)));
  } catch {
    // Storage unavailable or full: the view is simply not remembered.
  }
}

export function forgetView(doc: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(readViews(storage).filter(([key]) => key !== doc)));
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
