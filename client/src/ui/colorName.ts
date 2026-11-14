// A colour's name for screen readers ("Dark red"), so a palette's swatches are not read out as "#C00000". Named from the
// colour's hue and lightness: a dozen hues, and dark or light where it is far from the middle. The exact code stays the
// swatch's tooltip.

import { t, type MessageKey } from '../i18n/index.ts';

type Hue = 'red' | 'orange' | 'brown' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'gray' | 'black' | 'white';

/** The colour's hue and whether it is dark or light (null: a `#rgb` or `#rrggbb` it is not). */
export function colorKind(hex: string): { hue: Hue; tone: 'dark' | 'light' | null } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const chroma = max - min;
  if (chroma < 0.08) {
    if (light < 0.12) return { hue: 'black', tone: null };
    if (light > 0.94) return { hue: 'white', tone: null };
    return { hue: 'gray', tone: light < 0.4 ? 'dark' : light > 0.7 ? 'light' : null };
  }
  let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  const tone = light < 0.3 ? 'dark' : light > 0.75 ? 'light' : null;
  const name: Hue = hue < 15 || hue >= 335 ? 'red' : hue < 40 ? (light < 0.4 ? 'brown' : 'orange') : hue < 65 ? 'yellow' : hue < 165 ? 'green' : hue < 190 ? 'teal' : hue < 255 ? 'blue' : hue < 290 ? 'purple' : 'pink';
  return { hue: name, tone: name === 'brown' ? null : tone };
}

const HUE_NAMES: Record<Hue, MessageKey> = {
  red: 'a11y.color.red',
  orange: 'a11y.color.orange',
  brown: 'a11y.color.brown',
  yellow: 'a11y.color.yellow',
  green: 'a11y.color.green',
  teal: 'a11y.color.teal',
  blue: 'a11y.color.blue',
  purple: 'a11y.color.purple',
  pink: 'a11y.color.pink',
  gray: 'a11y.color.gray',
  black: 'a11y.color.black',
  white: 'a11y.color.white',
};

/** What a screen reader says for a colour: its name, or the code itself if it is not one we can name. */
export function colorName(hex: string): string {
  const kind = colorKind(hex);
  if (!kind) return hex;
  const color = t(HUE_NAMES[kind.hue]);
  return kind.tone ? t(kind.tone === 'dark' ? 'a11y.color.dark' : 'a11y.color.light', { color }) : color;
}
