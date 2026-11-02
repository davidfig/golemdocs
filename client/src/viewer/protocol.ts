// What the embeddable viewer and the page around it say to each other, and the small rules the viewer follows (which links it hands
// out, how far a zoom step goes). No DOM here, so all of it can be tested in Node. See docs/architecture/viewer.md.

/** Sent to the viewer page (viewer.html) by its host, with `postMessage`. `bytes` is best transferred. */
export type ToViewer = {
  type: 'golemdocs:open';
  /** The file's bytes. */
  bytes: ArrayBuffer;
  /** Its file name: the extension says what it is. */
  name: string;
  /** Where the fonts are, absolute or relative to the viewer page (default: `fonts/` beside it). */
  fontBase?: string;
  /** Dark colors around the pages, and dark pages with light letters. */
  dark?: boolean;
  /** The language of the viewer's own words (a BCP 47 tag; default English). */
  locale?: string;
};

/** Sent by the viewer page to its host (`window.parent`). */
export type FromViewer =
  /** The page has loaded and is waiting for a file. */
  | { type: 'golemdocs:ready' }
  /** The file is open and its pages are laid out: `format` is what it was read as. */
  | { type: 'golemdocs:opened'; name: string; format: string; pages: number }
  /** The file can't be shown. */
  | { type: 'golemdocs:error'; message: string }
  /** A link in the document was clicked: the viewer never follows one itself. */
  | { type: 'golemdocs:link'; url: string };

/** Reads a message as one the viewer takes, or null (anything else is ignored). */
export function readToViewer(data: unknown): ToViewer | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.type !== 'golemdocs:open' || typeof m.name !== 'string') return null;
  // An ArrayBuffer, or a view of one (a Uint8Array), whose bytes are copied out.
  const bytes = m.bytes instanceof ArrayBuffer ? m.bytes : ArrayBuffer.isView(m.bytes) ? new Uint8Array(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength).slice().buffer : null;
  if (!bytes) return null;
  return {
    type: 'golemdocs:open',
    bytes,
    name: m.name,
    ...(typeof m.fontBase === 'string' && m.fontBase && { fontBase: m.fontBase }),
    ...(typeof m.dark === 'boolean' && { dark: m.dark }),
    ...(typeof m.locale === 'string' && m.locale && { locale: m.locale }),
  };
}

/** Schemes of links handed to the host. Anything else (`javascript:`, `file:`, the app's own `doc:` and `tag:`, a bookmark in the document) is not. */
const HOST_LINK = /^(https?|mailto|tel|ftp):/i;

/** The link to hand to the host for a link's address, or null when the viewer drops it. */
export function linkForHost(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  return trimmed && HOST_LINK.test(trimmed) ? trimmed : null;
}

/** Zoom limits of the viewer (1 = 100%). */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

/** The zoom levels the buttons and Ctrl/⌘ + and − step through, as Word's zoom box lists them. */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 3, 4, 5, 6, 8] as const;

/** The next zoom level from `zoom`, in (`direction` 1) or out (-1): the next step past it, so a zoom between steps goes to the nearest one that way. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const eps = 1e-3;
  if (direction > 0) return ZOOM_STEPS.find((z) => z > zoom + eps) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - eps) ?? MIN_ZOOM;
}

/** The zoom that fits a page `pageWidth` points wide in a view `viewWidth` CSS px wide, leaving `margin` px: never above 100%. */
export function fitWidthZoom(pageWidth: number, viewWidth: number, margin: number, cssPerPoint: number): number {
  if (!(pageWidth > 0) || !(viewWidth > 0)) return 1;
  return Math.min(1, Math.max(MIN_ZOOM, (viewWidth - margin) / (pageWidth * cssPerPoint)));
}

/** The index of the page at document height `y` (points), for pages stacked top to bottom: the last one starting at or above it. */
export function pageIndexAt(pages: readonly { y: number; height: number }[], y: number): number {
  let lo = 0;
  let hi = pages.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].y <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A page number typed by the reader ("3"), as an index into `count` pages, or null when it isn't one. */
export function parsePageNumber(text: string, count: number): number | null {
  const match = /^\s*(\d+)\s*$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= count ? n - 1 : null;
}

/**
 * What the shared-document page (share.ts) does with the answer to a check for a newer save: show the `newer` file, keep what is
 * shown while it is `unchanged` or the check can be `retried` (offline, a server error), or take the document away because access
 * has `ended` (no longer shared, made an editor, the owner's plan ended) or the person was `signedOut`.
 */
export type CheckOutcome = 'newer' | 'unchanged' | 'retry' | 'ended' | 'signedOut';

/** The outcome for a response's status, or for no response at all (`null`: the request failed, offline). */
export function checkOutcome(status: number | null): CheckOutcome {
  if (status === 200) return 'newer';
  if (status === 304) return 'unchanged';
  if (status === 401) return 'signedOut';
  // 404: unknown or dropped token (unshared, left, made an editor). 403: the owner's subscription ended, which ends every share.
  if (status === 404 || status === 403) return 'ended';
  return 'retry';
}
