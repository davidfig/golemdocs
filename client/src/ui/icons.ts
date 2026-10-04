// Toolbar and menu icons, hand-drawn as inline SVG on a 24-unit grid (cropped to the
// inner 22 units) and shown at 20px.
// Style: chunky rounded ink outlines, flat bright fills, the odd white glint. Colors are
// fixed (disabled controls grey them out with a CSS filter); the font color and highlight
// icons show the current color through the --swatch custom property.

const INK = '#2e3148';
const BLUE = '#5b8def';
const SKY = '#cfe0ff';
const YELLOW = '#ffc93c';
const BUTTER = '#ffd66b';
const ORANGE = '#f5a623';
const RED = '#ff6b6b';
const PINK = '#ff8fab';
const GREEN = '#4cc38a';
const PURPLE = '#9b7bf7';
const PAPER = '#ffffff';
const MIST = '#e8ecf3';
const LINE = '#a3abbf';

const svg = (body: string) =>
  `<svg viewBox="1 1 22 22" width="20" height="20" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** A stroke with an ink outline: a wide ink line under a narrower colored one. */
const outlined = (d: string, color: string, width = 2.4) =>
  `<path d="${d}" stroke-width="${width + 1.8}"/><path d="${d}" stroke="${color}" stroke-width="${width}"/>`;

/** Text lines on a page or card. */
const textLines = (x: number, ys: number[], widths: number[], color = LINE) =>
  ys.map((y, i) => `<path d="M${x} ${y}h${widths[i]}" stroke="${color}"/>`).join('');

/** Paragraph lines for the alignment icons: [x1, x2] per row. */
const rows = (spans: [number, number][]) => spans.map(([x1, x2], i) => `<path d="M${x1} ${5 + i * 4.6}H${x2}" stroke-width="2.2"/>`).join('');

/** Where a color swatch sits under an icon (font color, highlight). */
const SWATCH = `<rect x="2.5" y="19" width="19" height="3.5" rx="1.5" fill="var(--swatch, transparent)" stroke="${INK}" stroke-width="1.2"/>`;

const page = (fill = PAPER) => `<path d="M6.5 2.5H14l5 5v13a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z" fill="${fill}"/><path d="M14 2.5v4a1 1 0 0 0 1 1h4" fill="${SKY}"/>`;

export const ICONS: Record<string, string> = {
  new: svg(
    page() +
      `<path d="M4.5 1.5l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1z" fill="${YELLOW}" stroke-width="1.1"/>`,
  ),
  open: svg(
    `<path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h4.3l2 2.2h8.2A1.5 1.5 0 0 1 20 7.7v2" fill="${ORANGE}"/>` +
      `<path d="M2.5 5.5V19" /><path d="M6.5 9.5V7.8h11v2" fill="${PAPER}"/>` +
      `<path d="M2.5 19.5l2.4-8.4a1.5 1.5 0 0 1 1.4-1.1h14.9a1 1 0 0 1 1 1.3l-2.3 7.7a1.5 1.5 0 0 1-1.4 1H3.5a1 1 0 0 1-1-.5z" fill="${BUTTER}"/>`,
  ),
  save: svg(
    `<path d="M4.5 3h12.3L21 7.2V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 1.5-2z" fill="${BLUE}"/>` +
      `<path d="M7.5 3h8.5v5a1 1 0 0 1-1 1H8.5a1 1 0 0 1-1-1z" fill="${MIST}"/><path d="M13.5 4.8v2.4" stroke-width="1.8"/>` +
      `<rect x="6.5" y="12.5" width="11" height="8.5" rx="1" fill="${PAPER}"/>` +
      textLines(8.8, [15.3, 18], [6.4, 4.2]),
  ),
  print: svg(
    `<path d="M7 8V3.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V8" fill="${PAPER}"/>` +
      `<path d="M3 10a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="${PURPLE}"/>` +
      `<circle cx="17.8" cy="11" r="1.1" fill="${GREEN}" stroke-width="1"/>` +
      `<path d="M7 14h10v7a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 7 21z" fill="${PAPER}"/>` +
      textLines(9.2, [17, 19.3], [5.6, 3.6]),
  ),
  printPreview: svg(
    page() +
      `<circle cx="14.5" cy="14.5" r="4.6" fill="${SKY}"/><path d="M12.2 13.3a2.5 2.5 0 0 1 1.9-1.6" stroke="${PAPER}" stroke-width="1.4"/>` +
      outlined('M18 18l3.3 3.3', PURPLE, 2.2),
  ),
  spelling: svg(
    `<text x="2" y="11.2" font-size="10" font-weight="800" font-family="ui-rounded, 'Arial Rounded MT Bold', 'Segoe UI', system-ui, sans-serif" fill="${INK}" stroke="none" letter-spacing="-.3">ABC</text>` +
      outlined('M6.5 16.5l3.5 3.5 8-7.5', GREEN, 2.6),
  ),
  cut: svg(
    outlined('M9.5 13.8L17.2 2.8', MIST, 2.2) +
      outlined('M14.5 13.8L6.8 2.8', MIST, 2.2) +
      `<circle cx="12" cy="10.6" r=".9" fill="${INK}" stroke="none"/>` +
      `<circle cx="7" cy="17.5" r="3.4" fill="${RED}"/><circle cx="7" cy="17.5" r="1.2" fill="${PAPER}" stroke-width="1.1"/>` +
      `<circle cx="17" cy="17.5" r="3.4" fill="${RED}"/><circle cx="17" cy="17.5" r="1.2" fill="${PAPER}" stroke-width="1.1"/>`,
  ),
  copy: svg(
    `<rect x="3.5" y="2.5" width="11" height="14" rx="2" fill="${SKY}"/>` +
      `<rect x="9.5" y="7.5" width="11" height="14" rx="2" fill="${PAPER}"/>` +
      textLines(12.3, [11.5, 14.5, 17.5], [5.4, 5.4, 3.4]),
  ),
  paste: svg(
    `<rect x="3" y="4" width="14.5" height="17.5" rx="2.2" fill="${ORANGE}"/>` +
      `<rect x="7" y="2.3" width="6.5" height="3.8" rx="1.3" fill="${MIST}"/>` +
      `<rect x="10.5" y="9.5" width="10.5" height="12" rx="1.6" fill="${PAPER}"/>` +
      textLines(13.2, [13.2, 16, 18.8], [5, 5, 3.2]),
  ),
  formatPainter: svg(
    `<rect x="3" y="3" width="14.5" height="6.5" rx="2.2" fill="${YELLOW}"/>` +
      `<path d="M5.5 5.3h6" stroke="${PAPER}" stroke-width="1.4"/>` +
      `<path d="M17.5 6.2h2a1 1 0 0 1 1 1v3.8a1 1 0 0 1-1 1H12v2.3" />` +
      `<rect x="10" y="14" width="4" height="8" rx="1.6" fill="${RED}"/>`,
  ),
  commandPalette: svg(
    `<rect x="2.5" y="4.5" width="19" height="15" rx="3" fill="${PAPER}"/>` +
      outlined('M7 9.5l3.2 2.5L7 14.5', BLUE, 2) +
      outlined('M12.5 15h4.5', ORANGE, 2),
  ),
  undo: svg(outlined('M8.5 8.5h6.5a5 5 0 0 1 0 10h-4', BLUE) + `<path d="M9.8 3.8L4 8.5l5.8 4.7z" fill="${BLUE}"/>`),
  redo: svg(outlined('M15.5 8.5H9a5 5 0 0 0 0 10h4', BLUE) + `<path d="M14.2 3.8L20 8.5l-5.8 4.7z" fill="${BLUE}"/>`),
  link: svg(
    `<g transform="rotate(-45 12 12)">` +
      outlined('M9.5 8.8H7a3.2 3.2 0 0 0 0 6.4h2.5', BLUE, 2.2) +
      outlined('M14.5 8.8H17a3.2 3.2 0 0 1 0 6.4h-2.5', GREEN, 2.2) +
      outlined('M9 12h6', MIST, 1.8) +
      `</g>`,
  ),
  // A sum sign on a card: equations.
  math: svg(
    `<rect x="2.5" y="3" width="19" height="18" rx="2.5" fill="${PAPER}"/>` +
      outlined('M16 7H8.5l4 5-4 5H16', PURPLE, 2.2),
  ),
  table: svg(
    `<rect x="2.5" y="3.5" width="19" height="17" rx="2.5" fill="${PAPER}"/>` +
      `<path d="M2.5 6A2.5 2.5 0 0 1 5 3.5h14A2.5 2.5 0 0 1 21.5 6v2.5h-19z" fill="${BLUE}"/>` +
      `<path d="M2.5 14.5h19M9 8.5v12M15 8.5v12"/>`,
  ),
  image: svg(
    `<rect x="2.5" y="3.5" width="19" height="17" rx="2.5" fill="${SKY}"/>` +
      `<path d="M2.5 17l5.5-6 4.5 4.5 3-3 6 6V18a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 18z" fill="${GREEN}"/>` +
      `<circle cx="16.2" cy="8.3" r="2.2" fill="${YELLOW}"/>`,
  ),
  rotateLeft: svg(
    `<rect x="9.5" y="9.5" width="11" height="11" rx="2" fill="${SKY}"/>` +
      `<path d="M4.5 12.5a7 7 0 0 1 6.5-6.7" stroke-width="2.2"/><path d="M9 3.5l2.4 2.5-2.9 1.9" fill="${ORANGE}"/>`,
  ),
  rotateRight: svg(
    `<rect x="3.5" y="9.5" width="11" height="11" rx="2" fill="${SKY}"/>` +
      `<path d="M19.5 12.5a7 7 0 0 0-6.5-6.7" stroke-width="2.2"/><path d="M15 3.5l-2.4 2.5 2.9 1.9" fill="${ORANGE}"/>`,
  ),
  flipHorizontal: svg(
    `<path d="M11 4v16" stroke-dasharray="2 2.2"/><path d="M9 6.5L3 19h6z" fill="${SKY}"/><path d="M15 6.5L21 19h-6z" fill="${BLUE}"/>`,
  ),
  flipVertical: svg(
    `<path d="M4 12h16" stroke-dasharray="2 2.2"/><path d="M6.5 10V4L19 10z" fill="${SKY}"/><path d="M6.5 14v6L19 14z" fill="${BLUE}"/>`,
  ),
  crop: svg(
    `<rect x="6.5" y="6.5" width="11" height="11" fill="${SKY}" stroke-width="1.2"/>` +
      `<path d="M7 2.5v14.5a1 1 0 0 0 1 1h14.5" stroke-width="2.4"/><path d="M2.5 7H17a1 1 0 0 1 1 1v14.5" stroke-width="2.4"/>`,
  ),
  resize: svg(
    `<rect x="2.5" y="9.5" width="11" height="11" rx="1.5" fill="${SKY}"/><path d="M11 13l8.5-8.5M14 4.5h5.5V10" stroke-width="2"/>`,
  ),
  adjust: svg(
    `<circle cx="12" cy="12" r="8.5" fill="${PAPER}"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="${INK}"/><path d="M12 3.5v17" stroke-width="1.2"/>`,
  ),
  rotate180: svg(
    `<rect x="7" y="9.5" width="10" height="10" rx="2" fill="${SKY}"/>` +
      `<path d="M4.5 13.5a7.5 7.5 0 0 1 14-3" stroke-width="2.2"/><path d="M19.8 6.5l-.4 4.3-4-1.2" fill="${ORANGE}"/>`,
  ),
  autoLevels: svg(
    `<path d="M4 20V4M20 20V4" stroke-width="1.2"/><path d="M7 19c2.5 0 3-13 5-13s2.5 13 5 13" fill="${SKY}"/><path d="M4.5 21h15" stroke-width="2.2"/>`,
  ),
  grayscale: svg(
    `<rect x="2.5" y="3.5" width="19" height="17" rx="2.5" fill="${MIST}"/><path d="M12 3.5h7a2.5 2.5 0 0 1 2.5 2.5v12a2.5 2.5 0 0 1-2.5 2.5h-7z" fill="${LINE}"/>`,
  ),
  sepia: svg(
    `<rect x="2.5" y="3.5" width="19" height="17" rx="2.5" fill="#e9c99a"/><path d="M2.5 17l5.5-6 4.5 4.5 3-3 6 6V18a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 18z" fill="#a9743f"/><circle cx="16.2" cy="8.3" r="2.2" fill="#f6e3c0"/>`,
  ),
  invert: svg(
    `<rect x="2.5" y="3.5" width="19" height="17" rx="2.5" fill="${PAPER}"/><path d="M12 3.5h7a2.5 2.5 0 0 1 2.5 2.5v12a2.5 2.5 0 0 1-2.5 2.5h-7z" fill="${INK}"/>`,
  ),
  blur: svg(
    `<circle cx="12" cy="12" r="8.5" fill="${SKY}" stroke-dasharray="2 2.6"/><circle cx="12" cy="12" r="4.5" fill="${BLUE}" stroke="none" opacity=".7"/>`,
  ),
  sharpen: svg(
    `<path d="M12 3.5l8.5 15.5h-17z" fill="${YELLOW}"/><path d="M12 9.5v4.5" stroke-width="2"/><circle cx="12" cy="16.6" r=".6" fill="${INK}"/>`,
  ),
  pen: svg(`<path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5z" fill="${YELLOW}"/><path d="M14.5 6l3.5 3.5M4 20l4.5-1-3.5-3.5z" fill="${MIST}"/>`),
  marker: svg(
    `<path d="M14.5 3.3l6.2 6.2-8 8-6.2-6.2z" fill="${YELLOW}"/><path d="M6.5 11.3l6.2 6.2-2.6 2.3H7.6l-3.5-3.5v-2.5z" fill="${MIST}"/><path d="M3 21.5h8" stroke="${YELLOW}" stroke-width="2.6"/>`,
  ),
  line: svg(`<path d="M5 19L19 5" stroke-width="2.6"/><circle cx="5" cy="19" r="1.8" fill="${SKY}"/><circle cx="19" cy="5" r="1.8" fill="${SKY}"/>`),
  arrow: svg(`<path d="M5 19L18 6" stroke-width="2.6"/><path d="M11 5.5h8.5V14z" fill="${RED}"/>`),
  rectangle: svg(`<rect x="3.5" y="6" width="17" height="12" rx="1.5" stroke-width="1.6" fill="${SKY}"/>`),
  // The Shapes tool: a star and a triangle.
  shapes: svg(`<path d='M8 3l1.700 3.600 3.800.5-2.800 2.700.7 3.800L8 11.700 4.600 13.600l.7-3.800L2.500 7.100l3.800-.5z' stroke-width='1.500' fill='${BUTTER}'/><path d='M17 11l5 10h-10z' stroke-width='1.800' fill='${SKY}'/>`),
  ellipse: svg(`<ellipse cx="12" cy="12" rx="9" ry="6.5" stroke-width="1.6" fill="${SKY}"/>`),
  text: svg(`<path d="M5 6.5V4.5h14v2M12 4.5v15M9 19.5h6" stroke-width="2.4"/>`),
  bubble: svg(`<path d="M6 4.5h12a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5h-6.5L6.5 20v-4.6A2.5 2.5 0 0 1 3.5 13V7A2.5 2.5 0 0 1 6 4.5z" fill="${PAPER}" stroke-width="2"/><path d="M8 9h8M8 12h5" stroke-width="1.6"/>`),
  step: svg(`<circle cx="12" cy="12" r="9" fill="${RED}"/><path d="M10.2 9.4L12.4 8v8" stroke="${PAPER}" stroke-width="2.2"/>`),
  pixelate: svg(
    `<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" fill="${MIST}"/>` +
      `<path d="M3.5 9.5h17M3.5 14.5h17M9.2 4.5v15M14.8 4.5v15" stroke-width="1"/>` +
      `<rect x="9.2" y="9.5" width="5.6" height="5" fill="${BLUE}" stroke="none"/><rect x="3.5" y="14.5" width="5.7" height="5" fill="${LINE}" stroke="none"/><rect x="14.8" y="4.5" width="5.7" height="5" fill="${LINE}" stroke="none"/>`,
  ),
  smudge: svg(`<path d="M5 17c2.500-1 4-3.500 5.500-6.500S14 6 18 6.500" stroke-width="3.400" stroke="${BLUE}"/><path d="M5 17c2.500-1 4-3.500 5.500-6.500S14 6 18 6.500" stroke-width="1.600" stroke="${SKY}"/><path d="M12 19.500c2-.5 4-2 6-4.500" stroke-width="1.400"/>`),
  blurBrush: svg(`<circle cx="12" cy="12" r="7.500" fill="${SKY}" stroke-dasharray="2 2.200"/><circle cx="12" cy="12" r="3.500" fill="${BLUE}" stroke="none" opacity=".7"/>`),
  sharpenBrush: svg(`<path d="M12 3.500l8 15.500H4z" fill="${SKY}"/><path d="M12 9v5" stroke-width="1.800"/>`),
  mixer: svg(`<path d="M4 15c2-5 4-5 6-2s4 2 6-3" stroke="${RED}" stroke-width="3.200"/><path d="M8 19c2-3 4-3 6-1s4 1 6-2" stroke="${BLUE}" stroke-width="3.200" opacity=".85"/>`),
  dodge: svg(`<circle cx="12" cy="12" r="4.500" fill="${YELLOW}"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.500 5.500l2 2M16.500 16.500l2 2M18.500 5.500l-2 2M7.500 16.500l-2 2" stroke-width="1.700"/>`),
  burn: svg(`<path d="M12 3c4 4.500 6 7 6 10a6 6 0 0 1-12 0c0-3 2-5.500 6-10z" fill="${ORANGE}"/><path d="M12 12c2 2 3 3 3 4.500a3 3 0 0 1-6 0c0-1.500 1-2.500 3-4.500z" fill="${YELLOW}" stroke-width="1.200"/>`),
  eyedropper: svg(`<path d="M4 20.5l1-4 8.500-8.500 3 3L8 19.500z" fill="${SKY}"/><path d="M12.500 7.500l-1-1 2.500-2.500a2.200 2.200 0 0 1 3.100 3.100l-2.500 2.500-1-1" fill="${LINE}"/><path d="M5.500 17l3 3" stroke-width="1"/>`),
  bucket: svg(`<path d="M4.500 12l7-7 8 8-7 7z" fill="${SKY}"/><path d="M5 11.500l12 .5M11.500 5L9 3.500" stroke-width="1.600"/><path d="M20 15.500c1.500 2 2 3 2 4a2 2 0 0 1-4 0c0-1 .5-2 2-4z" fill="${BLUE}"/>`),
  background: svg(`<rect x="3.500" y="4.500" width="17" height="15" rx="2" fill="${SKY}"/><path d="M3.500 15.500l5-5 4 4 3-3 5 5" fill="${GREEN}" stroke-width="1.400"/><circle cx="16" cy="9" r="1.600" fill="${YELLOW}" stroke-width="1.200"/>`),
  layersStack: svg(`<path d="M12 3.500l9 4.500-9 4.500L3 8z" fill="${SKY}"/><path d="M3 12l9 4.500 9-4.500M3 16l9 4.500 9-4.500" stroke-width="1.700"/>`),
  eraser: svg(`<path d="M14.5 4l6 6-8.5 8.5H7.5L3.5 14.5z" fill="${PINK}"/><path d="M9 9l6 6M8 20.5h12.5" stroke-width="2"/>`),
  import: svg(
    `<path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4" fill="${SKY}"/>` +
      outlined('M12 15V4', GREEN) +
      outlined('M7.5 8.5L12 4l4.5 4.5', GREEN),
  ),
  newFolder: svg(
    `<path d="M2.5 6.5A1.5 1.5 0 0 1 4 5h4.6l2 2.4H20A1.5 1.5 0 0 1 21.5 9v9.5A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5z" fill="${ORANGE}"/>` +
      `<circle cx="17.5" cy="16.5" r="5" fill="${GREEN}"/><path d="M17.5 14v5M15 16.5h5" stroke="${PAPER}" stroke-width="1.8"/>`,
  ),
  moveToFolder: svg(
    `<path d="M2.5 6.5A1.5 1.5 0 0 1 4 5h4.6l2 2.4H20A1.5 1.5 0 0 1 21.5 9v9.5A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5z" fill="${ORANGE}"/>` +
      `<path d="M7 13h8M12 9.5l3.5 3.5-3.5 3.5" stroke="${PAPER}" stroke-width="2"/>`,
  ),
  trash: svg(
    `<path d="M5 7h14l-1.2 12.4a1.5 1.5 0 0 1-1.5 1.35H7.7a1.5 1.5 0 0 1-1.5-1.35z" fill="${SKY}"/>` +
      `<path d="M3.5 7h17" stroke-width="2"/><path d="M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7" fill="${PAPER}"/>` +
      `<path d="M10 11v6M14 11v6" stroke="${RED}" stroke-width="1.8"/>`,
  ),
  share: svg(
    `<circle cx="6.5" cy="12" r="2.8" fill="${BLUE}"/><circle cx="17.5" cy="6" r="2.8" fill="${GREEN}"/><circle cx="17.5" cy="18" r="2.8" fill="${PINK}"/>` +
      `<path d="M9 10.6l6-3.2M9 13.4l6 3.2" stroke-width="1.8"/>`,
  ),
  rename: svg(`<path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5z" fill="${YELLOW}"/><path d="M14.5 6l3.5 3.5M4 20l4.5-1-3.5-3.5z" fill="${MIST}"/>`),
  leave: svg(
    `<path d="M10 4H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h4" fill="${SKY}"/>` + outlined('M9.5 12h10', RED) + outlined('M16 8l4 4-4 4', RED),
  ),
  move: svg(`<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" stroke-width="2"/>`),
  unite: svg(`<rect x="3.5" y="3.5" width="12" height="12" fill="${BLUE}"/><rect x="8.5" y="8.5" width="12" height="12" fill="${BLUE}"/>`),
  intersect: svg(`<rect x="3.5" y="3.5" width="12" height="12" fill="${MIST}"/><rect x="8.5" y="8.5" width="12" height="12" fill="${MIST}"/><rect x="8.5" y="8.5" width="7" height="7" fill="${BLUE}"/>`),
  subtract: svg(`<rect x="3.5" y="3.5" width="12" height="12" fill="${BLUE}"/><rect x="8.5" y="8.5" width="12" height="12" fill="${PAPER}" stroke-dasharray="2.5 2.5" stroke-width="1.4"/>`),
  exclude: svg(`<rect x="3.5" y="3.5" width="12" height="12" fill="${BLUE}"/><rect x="8.5" y="8.5" width="12" height="12" fill="${BLUE}"/><rect x="8.5" y="8.5" width="7" height="7" fill="${PAPER}" stroke-width="1.2"/>`),
  clipMask: svg(`<rect x="3.5" y="3.5" width="17" height="17" rx="1.5" fill="${MIST}" stroke-dasharray="2.5 2.5" stroke-width="1.4"/><circle cx="12" cy="12" r="5.5" fill="${BLUE}"/>`),
  // The pen: a nib over a curve with anchor points, as the Bézier pen of drawing programs is shown.
  penTool: svg(`<path d='M3.500 19.500C4.500 14 8 11.500 11 13' fill='none' stroke-width='1.500'/><rect x='2' y='18' width='3.600' height='3.600' rx='.6' fill='${PAPER}' stroke-width='1.200'/><rect x='9.200' y='11.200' width='3.600' height='3.600' rx='.6' fill='${PAPER}' stroke-width='1.200'/><path d='M11 13L17.900 10L24.300 3.700L20.300 -.3L14 6.100z' fill='${YELLOW}' stroke='none'/><path d='M11 13L17.900 10L14 6.100z' fill='${BUTTER}' stroke='none'/><path d='M20.300 -.3L14 6.100L11 13L17.900 10L24.300 3.700' fill='none'/><path d='M14 6.100L17.900 10' stroke-width='1.200'/><circle cx='14.100' cy='10' r='.9' fill='${PAPER}' stroke-width='1'/>`),
  pencil: svg(`<path d='M4 19.5l1.2-4.2L16.6 4a2.1 2.1 0 0 1 3 3L8.2 18.3z' fill='${PINK}'/><path d='M14.8 5.8l3.4 3.4M4 19.5l4.2-1.2-3-3z' fill='${MIST}'/><path d='M3.5 21.5c2-1.5 3 .5 5-.5s3-1 4.500-.2' fill='none' stroke-width='1.3'/>`),
  // The nudge: a fingertip, nail and all, pushes a line up into a bump, the line just clear of the finger.
  nudge: svg(`<path d='M2 12.500h2.500c2 0 2.500-5 7.500-5s5.500 5 7.500 5H22' stroke='${BLUE}' stroke-width='2.200'/><path d='M8.500 23V15a3.500 3.500 0 0 1 7 0V23z' fill='${BUTTER}' stroke='none'/><path d='M8.500 23V15a3.500 3.500 0 0 1 7 0V23' stroke-width='1.400'/><path d='M10 15.500a2 2 0 0 1 4 0v1.200a2 2 0 0 1-4 0z' fill='#ffe1e8' stroke-width='.9'/>`),
  // The canvas tool: a page with a handle on each corner and side, one pulled out past its edge.
  canvasTool: svg(`<rect x='5' y='5' width='14' height='14' fill='${MIST}'/><path d='M19 12h3.500M20.500 10.500L22.500 12l-2 1.500' fill='none' stroke='${BLUE}' stroke-width='1.600'/><rect x='3.500' y='3.500' width='3' height='3' fill='${PAPER}' stroke-width='1.200'/><rect x='17.500' y='3.500' width='3' height='3' fill='${PAPER}' stroke-width='1.200'/><rect x='3.500' y='17.500' width='3' height='3' fill='${PAPER}' stroke-width='1.200'/><rect x='17.500' y='17.500' width='3' height='3' fill='${PAPER}' stroke-width='1.200'/>`),
  newLayer: svg(`<path d='M12 3.500l9 4.500-9 4.500-9-4.500z' fill='${SKY}'/><path d='M3 12l9 4.500 9-4.500M3 16l9 4.500 9-4.500' fill='none'/><path d='M19 2.500v4M17 4.500h4' stroke='${GREEN}' stroke-width='2.200'/>`),
  newGroup: svg(`<rect x='3.500' y='6' width='14' height='13' rx='1.500' stroke-dasharray='2.500 2.500' stroke-width='1.400'/><rect x='6.500' y='9' width='5' height='5' fill='${SKY}'/><path d='M19 2.500v4M17 4.500h4' stroke='${GREEN}' stroke-width='2.200'/>`),
  select: svg(`<path d="M6.5 3.5l11 7.2-5 1.2 2.6 5.6-2.4 1.1-2.6-5.6-3.6 3.6z" fill="${PAPER}"/>`),
  group: svg(`<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="2.5 2.5" stroke-width="1.4"/><rect x="7" y="7" width="6.5" height="6.5" fill="${SKY}"/><rect x="10.5" y="10.5" width="6.5" height="6.5" fill="${BLUE}"/>`),
  ungroup: svg(`<rect x="3.5" y="3.5" width="9" height="9" fill="${SKY}"/><rect x="11.5" y="11.5" width="9" height="9" fill="${BLUE}"/>`),
  toFront: svg(`<rect x="3.5" y="3.5" width="11" height="11" fill="${MIST}"/><rect x="9.5" y="9.5" width="11" height="11" fill="${BLUE}"/>`),
  toBack: svg(`<rect x="9.5" y="9.5" width="11" height="11" fill="${MIST}"/><rect x="3.5" y="3.5" width="11" height="11" fill="${BLUE}"/>`),
  forward: svg(`<rect x="3.5" y="5.5" width="10" height="10" fill="${MIST}"/><rect x="9.5" y="9.5" width="11" height="11" fill="${BLUE}"/><path d="M14 4v5M11.8 6.2L14 4l2.2 2.2" stroke-width="1.6"/>`),
  backward: svg(`<rect x="9.5" y="9.5" width="11" height="11" fill="${MIST}"/><rect x="3.5" y="3.5" width="11" height="11" fill="${BLUE}"/><path d="M19 4v5M16.8 6.8L19 9l2.2-2.2" stroke-width="1.6"/>`),
  fill: svg(`<rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="${BLUE}" stroke-width="2.2"/>`),
  // The vector editor's fill and stroke show the selection's actual paint through --swatch (a color, or a gradient from --grad-a to --grad-b) and --none (1 draws a red slash).
  vectorFill: svg(`<defs><linearGradient id="wm-swatch-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" style="stop-color:var(--grad-a,#fff)"/><stop offset="1" style="stop-color:var(--grad-b,#fff)"/></linearGradient></defs><rect x="3" y="5" width="18" height="14" rx="2" fill="var(--swatch, transparent)" stroke-width="1.6"/><path d="M4.5 18.5L19.5 5.5" stroke="#d03030" stroke-width="2" style="opacity:var(--none, 0)"/>`),
  vectorStroke: svg(`<rect x="4" y="6" width="16" height="12" stroke="var(--swatch, transparent)" stroke-width="3.6"/><rect x="2.2" y="4.2" width="19.6" height="15.6" stroke-width="1"/><rect x="5.8" y="7.8" width="12.4" height="8.4" stroke-width="1"/><path d="M4.5 18.5L19.5 5.5" stroke="#d03030" stroke-width="2" style="opacity:var(--none, 0)"/>`),
  drawColor: svg(`<path d="M4 17l1-4 9.5-9.5a2.1 2.1 0 0 1 3 3L8 16z" fill="${YELLOW}"/><path d="M4 17l4-1-3-3z" fill="${MIST}"/>` + SWATCH),
  comment: svg(
    `<path d="M4.5 3.5h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H11.5l-5 4.5v-4.5h-2a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" fill="${BUTTER}"/>` +
      `<path d="M6.5 8h11M6.5 11.5h7" stroke-width="1.8"/>`,
  ),
  pageBreak: svg(
    `<path d="M5 2.5v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" fill="${PAPER}"/>` +
      `<path d="M5 21.5v-5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v5" fill="${PAPER}"/>` +
      `<path d="M2 12h20" stroke="${RED}" stroke-width="2.2" stroke-dasharray="2.6 2.4"/>`,
  ),
  paragraphMarks: svg(
    `<path d="M11 4.5H9.2a4 4 0 0 0 0 8H11z" fill="${BLUE}"/>` + `<path d="M11 4.5h7.5M11 4.5v15M15.5 4.5v15" stroke-width="2.2"/>`,
  ),
  find: svg(
    `<circle cx="10" cy="10" r="6.3" fill="${SKY}"/><path d="M6.8 8.8a3.6 3.6 0 0 1 2.8-2.6" stroke="${PAPER}" stroke-width="1.6"/>` +
      outlined('M14.8 14.8l5.5 5.5', PURPLE, 2.6),
  ),
  zoom: svg(
    `<circle cx="10" cy="10" r="6.3" fill="${PAPER}"/><path d="M7.2 10h5.6M10 7.2v5.6" stroke-width="2"/>` + outlined('M14.8 14.8l5.5 5.5', PURPLE, 2.6),
  ),
  alignLeft: svg(rows([[3, 21], [3, 14], [3, 21], [3, 12]])),
  alignCenter: svg(rows([[3, 21], [7, 17], [3, 21], [8, 16]])),
  alignRight: svg(rows([[3, 21], [10, 21], [3, 21], [12, 21]])),
  justify: svg(rows([[3, 21], [3, 21], [3, 21], [3, 21]])),
  bullets: svg(
    `<circle cx="4.5" cy="5.5" r="2.1" fill="${RED}" stroke-width="1.2"/><circle cx="4.5" cy="12" r="2.1" fill="${YELLOW}" stroke-width="1.2"/><circle cx="4.5" cy="18.5" r="2.1" fill="${BLUE}" stroke-width="1.2"/>` +
      `<path d="M9.5 5.5h11M9.5 12h11M9.5 18.5h11" stroke-width="2.2"/>`,
  ),
  checklist: svg(
    `<rect x="2.5" y="3.5" width="6" height="6" rx="1.3" fill="none" stroke="${BLUE}" stroke-width="1.5"/><path d="M4 6.6l1.5 1.5 2.5-3.2" fill="none" stroke="${GREEN}" stroke-width="1.8"/>` +
      `<rect x="2.5" y="14.5" width="6" height="6" rx="1.3" fill="none" stroke="${BLUE}" stroke-width="1.5"/>` +
      `<path d="M11.5 6.5h9M11.5 17.5h9" stroke-width="2.2"/>`,
  ),
  numbering: svg(
    ['1', '2', '3']
      .map(
        (n, i) =>
          `<text x="2.3" y="${8 + i * 6.5}" font-size="7.5" font-weight="800" font-family="ui-rounded, 'Arial Rounded MT Bold', 'Segoe UI', system-ui, sans-serif" fill="${[RED, ORANGE, BLUE][i]}" stroke="none">${n}</text>`,
      )
      .join('') + `<path d="M9.5 5.5h11M9.5 12h11M9.5 18.5h11" stroke-width="2.2"/>`,
  ),
  indentDecrease: svg(
    `<path d="M11 4.5h10M11 9.5h10M11 14.5h10M3 19.5h18" stroke-width="2.2"/><path d="M7.5 7.5L3 12l4.5 4.5z" fill="${BLUE}"/>`,
  ),
  indentIncrease: svg(
    `<path d="M11 4.5h10M11 9.5h10M11 14.5h10M3 19.5h18" stroke-width="2.2"/><path d="M3 7.5L7.5 12 3 16.5z" fill="${BLUE}"/>`,
  ),
  lineSpacing: svg(
    `<path d="M11 5h10M11 12h10M11 19h10" stroke-width="2.2"/>` +
      outlined('M5.5 4.5v15', BLUE, 1.8) +
      `<path d="M2.5 6.5l3-3.5 3 3.5zM2.5 17.5l3 3.5 3-3.5z" fill="${BLUE}" stroke-width="1.3"/>`,
  ),
  fontColor: svg(`<path d="M5.5 16L12 2.8 18.5 16M8 11.2h8" stroke-width="2.6"/>` + SWATCH),
  highlight: svg(
    `<path d="M14.5 2.3l6.2 6.2-7.2 7.2-6.2-6.2z" fill="${YELLOW}"/>` +
      `<path d="M15.8 4.8l2.4 2.4" stroke="${PAPER}" stroke-width="1.4"/>` +
      `<path d="M7.3 9.5l6.2 6.2-2.3 2.1H8.5l-3.3-3.3v-2.7z" fill="${MIST}"/>` +
      `<path d="M5.2 14.5l3.3 3.3-3.8.8z" fill="${INK}"/>` +
      SWATCH,
  ),
  clearFormatting: svg(
    `<path d="M3 16L8.5 3.2 14 16M5.4 11h6.2" stroke-width="2.4"/>` +
      `<path d="M13 17l5.3-5.3a1.6 1.6 0 0 1 2.2 0l1.3 1.3a1.6 1.6 0 0 1 0 2.2L17.2 19.8H14.5z" fill="${PINK}"/>` +
      `<path d="M15.3 14.7l3.5 3.5"/>`,
  ),
  columns: svg(
    `<path d="M3 5h7M3 9.6h7M3 14.2h7M3 18.8h5M14 5h7M14 9.6h7M14 14.2h7M14 18.8h5" stroke-width="2.2"/>`,
  ),
  borders: svg(
    `<rect x="3.5" y="3.5" width="17" height="17" rx="1.5" stroke="${LINE}" stroke-dasharray="2 2.2"/>` +
      outlined('M3.5 20.5h17', BLUE, 2.4),
  ),
  properties: svg(
    page() +
      `<circle cx="16.5" cy="16.5" r="5.5" fill="${BLUE}"/><path d="M16.5 15.5v3.8" stroke="${PAPER}" stroke-width="2"/><circle cx="16.5" cy="13.2" r="1.1" fill="${PAPER}" stroke="none"/>`,
  ),
  wordCount: svg(
    `<rect x="3.5" y="3" width="17" height="18" rx="2.5" fill="${PAPER}"/>` +
      `<text x="12" y="15" text-anchor="middle" font-size="7.2" font-weight="800" font-family="ui-rounded, 'Arial Rounded MT Bold', 'Segoe UI', system-ui, sans-serif" fill="${PURPLE}" stroke="none">123</text>`,
  ),
  trackChanges: svg(
    `<rect x="3.5" y="2.5" width="13" height="17" rx="2" fill="${PAPER}"/>` +
      textLines(6.5, [7, 10.5], [7, 5]) +
      `<path d="M10.5 19.8l8.7-8.7a1.5 1.5 0 0 1 2.1 0l.6.6a1.5 1.5 0 0 1 0 2.1l-8.7 8.7H10.5z" fill="${YELLOW}"/><path d="M10.5 19.8v2.7h2.7" fill="${INK}"/>`,
  ),
  symbol: svg(
    `<text x="12" y="19.5" text-anchor="middle" font-size="19" font-weight="800" font-family="Georgia, 'Times New Roman', serif" fill="${PURPLE}" stroke="${INK}" stroke-width="1.3" paint-order="stroke">Ω</text>`,
  ),
  help: svg(
    `<circle cx="12" cy="12" r="9.5" fill="${BLUE}"/>` +
      `<path d="M9.2 9.3a2.8 2.8 0 1 1 3.9 2.6c-.8.4-1.1.9-1.1 1.8v.5" stroke="${PAPER}" stroke-width="2.2"/><circle cx="12" cy="17.3" r="1.3" fill="${PAPER}" stroke="none"/>`,
  ),
  combo: svg(
    `<rect x="2.5" y="7" width="19" height="10" rx="2" fill="${PAPER}"/><path d="M15.5 7v10" /><path d="M17 11l1.5 1.8L20 11" stroke-width="1.4"/>` +
      `<path d="M5 12h7" stroke="${LINE}" stroke-width="1.8"/>`,
  ),
  dropdown: `<svg viewBox="0 0 8 5" width="8" height="5" aria-hidden="true"><path d="M1 1h6L4 4z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>`,
  menu: `<svg viewBox="0 0 20 16" width="20" height="16" aria-hidden="true"><path d="M2 3h16M2 8h16M2 13h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  back: `<svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true"><path d="M9 2L3 8l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  close: `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  submenu: `<svg viewBox="0 0 5 8" width="5" height="8" aria-hidden="true"><path d="M1 1v6l3-3z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>`,
  check: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="${BLUE}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  radio: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="${BLUE}"/></svg>`,
};

const ROUNDED = `ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', 'Segoe UI', system-ui, sans-serif`;

/** Toolbar buttons drawn as letters rather than pictures. */
export const LETTER_ICONS: Record<string, { text: string; style: string }> = {
  bold: { text: 'B', style: `font-weight:900;font-family:${ROUNDED}` },
  italic: { text: 'I', style: `font-weight:700;font-style:italic;font-family:Georgia,'Times New Roman',serif;font-size:18px` },
  underline: {
    text: 'U',
    style: `font-weight:700;font-family:${ROUNDED};text-decoration:underline;text-decoration-color:${BLUE};text-decoration-thickness:2.5px;text-underline-offset:2px`,
  },
  strikethrough: {
    text: 'abc',
    style: `font-weight:700;font-family:${ROUNDED};font-size:12.5px;text-decoration:line-through;text-decoration-color:${RED};text-decoration-thickness:2px`,
  },
  superscript: { text: 'x²', style: `font-weight:700;font-family:${ROUNDED};font-size:14.5px` },
  subscript: { text: 'x₂', style: `font-weight:700;font-family:${ROUNDED};font-size:14.5px` },
  code: { text: '</>', style: `font-weight:700;font-family:ui-monospace,monospace;font-size:11.5px;letter-spacing:-0.5px;color:${PURPLE}` },
  growFont: { text: 'A▴', style: `font-weight:700;font-family:${ROUNDED};font-size:14.5px` },
  shrinkFont: { text: 'A▾', style: `font-weight:700;font-family:${ROUNDED};font-size:11.5px` },
};

export function iconElement(name: string | undefined): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'icon';
  if (!name) return el;
  const letter = LETTER_ICONS[name];
  if (letter) {
    el.classList.add('letter');
    el.textContent = letter.text;
    el.setAttribute('style', letter.style);
  } else if (ICONS[name]) {
    el.innerHTML = ICONS[name];
  }
  return el;
}
