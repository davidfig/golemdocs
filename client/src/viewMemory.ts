// Where each document was left: the scroll position and zoom, kept in this browser so reopening a
// document puts the view back. Keyed by the document's source ("local:<id>", "cloud:<id>", ...),
// newest first, and capped so it never grows without bound.

const STORAGE_KEY = 'golemdocs.views';
export const MAX_VIEWS = 200;

/** The scroll position and zoom: the document point at the top-left of the window, and which view it was in. */
export interface SavedCamera {
  x: number;
  y: number;
  zoom: number;
  /** Normal (reflowed) or Print layout: a position in one means nothing in the other. */
  reflow: boolean;
}

/** Where the caret was: a page's index and a point on it (points from the page's corner). */
export interface SavedCaret {
  page: number;
  x: number;
  y: number;
}

/** Where a document was left. Either part is missing when it was never moved. */
export interface SavedView {
  camera?: SavedCamera;
  caret?: SavedCaret;
}

const numbers = (o: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]));
const isCamera = (v: unknown): v is SavedCamera => {
  const o = v as Record<string, unknown> | null;
  return !!o && numbers(o, ['x', 'y', 'zoom']) && (o.zoom as number) > 0 && typeof o.reflow === 'boolean';
};
const isCaret = (v: unknown): v is SavedCaret => {
  const o = v as Record<string, unknown> | null;
  return !!o && numbers(o, ['page', 'x', 'y']) && (o.page as number) >= 0;
};
/** A stored view with only its valid parts, or null if none is. */
const cleanView = (v: unknown): SavedView | null => {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const view: SavedView = {};
  if (isCamera(o.camera)) view.camera = o.camera;
  if (isCaret(o.caret)) view.caret = o.caret;
  return view.camera || view.caret ? view : null;
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
