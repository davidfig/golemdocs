// A deck's theme (docs/slides.md): its twelve colours, its heading and body fonts, and its style matrix (the fills, lines and
// backgrounds that shapes point at with `p:style` and `bgRef`). Read from `ppt/theme/themeN.xml`.

import type { XmlElement } from '@golemdocs/docx';
import { hex, type Rgba } from './color.ts';
import { at, kid, kids } from './ooxml.ts';

export interface ThemeFonts {
  latin: string;
  ea: string;
  cs: string;
}

export interface Theme {
  name: string;
  colors: Record<string, Rgba>;
  major: ThemeFonts;
  minor: ThemeFonts;
  /** The style matrix: fills (`fillRef` 1 to 3), lines (`lnRef`), background fills (`bgRef` 1001 and up). */
  fills: XmlElement[];
  lines: XmlElement[];
  backgrounds: XmlElement[];
}

const SCHEME = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

/** Office's own theme, for a deck whose theme is missing. */
export const OFFICE_COLORS: Record<string, string> = {
  dk1: '000000',
  lt1: 'FFFFFF',
  dk2: '0E2841',
  lt2: 'E8E8E8',
  accent1: '156082',
  accent2: 'E97132',
  accent3: '196B24',
  accent4: '0F9ED5',
  accent5: 'A02B93',
  accent6: '4EA72E',
  hlink: '467886',
  folHlink: '96607D',
};

export function defaultTheme(): Theme {
  const colors: Record<string, Rgba> = {};
  for (const [k, v] of Object.entries(OFFICE_COLORS)) colors[k] = hex(v)!;
  return {
    name: 'Office',
    colors,
    major: { latin: 'Aptos Display', ea: '', cs: '' },
    minor: { latin: 'Aptos', ea: '', cs: '' },
    fills: [],
    lines: [],
    backgrounds: [],
  };
}

function fonts(element: XmlElement | undefined, fallback: string): ThemeFonts {
  return {
    latin: kid(element, 'a:latin')?.attrs.typeface || fallback,
    ea: kid(element, 'a:ea')?.attrs.typeface ?? '',
    cs: kid(element, 'a:cs')?.attrs.typeface ?? '',
  };
}

export function readTheme(root: XmlElement | undefined): Theme {
  const theme = defaultTheme();
  if (!root) return theme;
  theme.name = root.attrs.name ?? theme.name;
  const scheme = at(root, 'a:themeElements/a:clrScheme');
  for (const name of SCHEME) {
    const holder = kid(scheme, `a:${name}`);
    const srgb = kid(holder, 'a:srgbClr');
    const sys = kid(holder, 'a:sysClr');
    const color = srgb ? hex(srgb.attrs.val) : sys ? hex(sys.attrs.lastClr) : null;
    if (color) theme.colors[name] = color;
  }
  const fontScheme = at(root, 'a:themeElements/a:fontScheme');
  theme.major = fonts(kid(fontScheme, 'a:majorFont'), theme.major.latin);
  theme.minor = fonts(kid(fontScheme, 'a:minorFont'), theme.minor.latin);
  const fmt = at(root, 'a:themeElements/a:fmtScheme');
  theme.fills = kids(kid(fmt, 'a:fillStyleLst'));
  theme.lines = kids(kid(fmt, 'a:lnStyleLst'));
  theme.backgrounds = kids(kid(fmt, 'a:bgFillStyleLst'));
  return theme;
}

/** The font a typeface names: `+mj-lt` and the like are the theme's. */
export function themeFont(typeface: string | undefined, theme: Theme): string | undefined {
  if (!typeface) return undefined;
  switch (typeface) {
    case '+mj-lt':
      return theme.major.latin;
    case '+mn-lt':
      return theme.minor.latin;
    case '+mj-ea':
      return theme.major.ea || theme.major.latin;
    case '+mn-ea':
      return theme.minor.ea || theme.minor.latin;
    case '+mj-cs':
      return theme.major.cs || theme.major.latin;
    case '+mn-cs':
      return theme.minor.cs || theme.minor.latin;
    default:
      return typeface;
  }
}
