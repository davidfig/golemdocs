// The drawing kit every toolbar icon is made with (icons.ts), and the few icons the site's viewer pages use as well (viewer.ts: print,
// find, zoom, download). They are kept apart from the full set so the viewer, which every visitor of a shared document loads, doesn't
// carry the rest of it (about 28 kB). icons.ts puts these into ICONS, so the app draws them from the same definitions.
// Style: chunky rounded ink outlines, flat bright fills, the odd white glint, on a 24-unit grid cropped to the inner 22 and shown at 20px.

export const INK = '#2e3148';
export const BLUE = '#5b8def';
export const SKY = '#cfe0ff';
export const YELLOW = '#ffc93c';
export const BUTTER = '#ffd66b';
export const ORANGE = '#f5a623';
export const RED = '#ff6b6b';
export const PINK = '#ff8fab';
export const GREEN = '#4cc38a';
export const PURPLE = '#9b7bf7';
export const PAPER = '#ffffff';
export const MIST = '#e8ecf3';
export const LINE = '#a3abbf';

export const svg = (body: string) =>
  `<svg viewBox="1 1 22 22" width="20" height="20" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** A stroke with an ink outline: a wide ink line under a narrower colored one. */
export const outlined = (d: string, color: string, width = 2.4) =>
  `<path d="${d}" stroke-width="${width + 1.8}"/><path d="${d}" stroke="${color}" stroke-width="${width}"/>`;

/** Text lines on a page or card. */
export const textLines = (x: number, ys: number[], widths: number[], color = LINE) =>
  ys.map((y, i) => `<path d="M${x} ${y}h${widths[i]}" stroke="${color}"/>`).join('');

/** The icons the viewer's bar shows, by the names ICONS has them under. */
export const BASIC_ICONS: Record<string, string> = {
  print: svg(
    `<path d="M7 8V3.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V8" fill="${PAPER}"/>` +
      `<path d="M3 10a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="${PURPLE}"/>` +
      `<circle cx="17.8" cy="11" r="1.1" fill="${GREEN}" stroke-width="1"/>` +
      `<path d="M7 14h10v7a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 7 21z" fill="${PAPER}"/>` +
      textLines(9.2, [17, 19.3], [5.6, 3.6]),
  ),
  find: svg(
    `<circle cx="10" cy="10" r="6.3" fill="${SKY}"/><path d="M6.8 8.8a3.6 3.6 0 0 1 2.8-2.6" stroke="${PAPER}" stroke-width="1.6"/>` +
      outlined('M14.8 14.8l5.5 5.5', PURPLE, 2.6),
  ),
  zoom: svg(
    `<circle cx="10" cy="10" r="6.3" fill="${PAPER}"/><path d="M7.2 10h5.6M10 7.2v5.6" stroke-width="2"/>` + outlined('M14.8 14.8l5.5 5.5', PURPLE, 2.6),
  ),
  zoomOut: svg(`<circle cx="10" cy="10" r="6.3" fill="${PAPER}"/><path d="M7.2 10h5.6" stroke-width="2"/>` + outlined('M14.8 14.8l5.5 5.5', PURPLE, 2.6)),
  /** Saves the file shown (the viewer pages): an arrow down into a tray, Import's turned over. */
  download: svg(`<path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4" fill="${SKY}"/>` + outlined('M12 4v11', BLUE) + outlined('M7.5 10.5L12 15l4.5-4.5', BLUE)),
  /** Saves every file of a shared folder as one ZIP: an arrow down into a folder. */
  downloadAll: svg(
    `<path d="M2.5 7.5A1.5 1.5 0 0 1 4 6h5l2 2h9a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5z" fill="${YELLOW}"/>` +
      outlined('M12 9.5v6', BLUE, 2.2) +
      outlined('M9 13l3 3 3-3', BLUE, 2.2),
  ),
};

/** View › Full Screen in the viewer's bar: a screen with its corners pushed out. */
BASIC_ICONS.fullScreen = svg(
  `<rect x="5" y="6" width="14" height="12" rx="1.5" fill="${SKY}"/>` +
    outlined('M3 7.5V3.5h4M17 3.5h4v4M21 16.5v4h-4M7 20.5H3v-4', BLUE, 1.8),
);

/** An icon's markup in the `.icon` span every toolbar button holds. */
export function iconSpan(markup: string | undefined): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'icon';
  if (markup) el.innerHTML = markup;
  return el;
}
