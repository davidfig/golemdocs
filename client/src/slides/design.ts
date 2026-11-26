// A deck's design (docs/slides.md, M5): slide backgrounds, the theme's colours and fonts, and the master's text styles. Each
// change is made on the XML of the part that holds it (a slide, layout or master; the theme part), recorded in a transaction,
// and touches only the elements it is about, so everything else in those parts is written back as it came.

import { OpcPackage, el, parseXml, type XmlElement } from '@golemdocs/docx';
import { hexOf } from '../drawingml/color.ts';
import { readTheme } from '../drawingml/theme.ts';
import { Deck, isLayoutPart, isMasterPart, isSlidePart, type DeckPart, type MasterPart, type PagePart } from './deck.ts';
import type { Transaction } from './history.ts';
import { REL_TYPE, at, findAll, insertBefore, kid, kids, replaceKid } from './ooxml.ts';
import { placeholderOf } from './shapes.ts';
import { masterStyleFor } from './textStyle.ts';

export { levelOf, levelRunOf, levelsIn } from '../drawingml/textEdit.ts';

// ---- Backgrounds ----------------------------------------------------------------------------------------------------

/** A background to set: a colour, a two-colour gradient at an angle, or a picture (a media part already in the deck). */
export type BackgroundSpec =
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; from: string; to: string; angle: number }
  | { kind: 'picture'; media: string };

/** Children of `p:cSld`, in schema order: a background comes first. */
const CSLD_AFTER_BG = ['p:spTree', 'p:custDataLst', 'p:controls', 'p:extLst'];

const hex = (color: string): string => color.replace(/^#/, '').toUpperCase().slice(0, 6).padEnd(6, '0');

/** The `p:bg` element for a background. `rId` is the picture's relationship, made by the caller. */
export function backgroundXml(spec: BackgroundSpec, rId = ''): XmlElement {
  let fill: XmlElement;
  if (spec.kind === 'solid') fill = el('a:solidFill', {}, [el('a:srgbClr', { val: hex(spec.color) })]);
  else if (spec.kind === 'gradient') {
    fill = el('a:gradFill', { rotWithShape: '1' }, [
      el('a:gsLst', {}, [el('a:gs', { pos: '0' }, [el('a:srgbClr', { val: hex(spec.from) })]), el('a:gs', { pos: '100000' }, [el('a:srgbClr', { val: hex(spec.to) })])]),
      el('a:lin', { ang: String(Math.round((((spec.angle % 360) + 360) % 360) * 60000)), scaled: '0' }),
    ]);
  } else fill = el('a:blipFill', { dpi: '0', rotWithShape: '1' }, [el('a:blip', { 'r:embed': rId }), el('a:srcRect'), el('a:stretch', {}, [el('a:fillRect')])]);
  return el('p:bg', {}, [el('p:bgPr', {}, [fill, el('a:effectLst')])]);
}

/** Removes a picture relationship nothing in the part points at any more. */
function dropUnusedRel(part: DeckPart, rId: string | undefined): void {
  if (!rId) return;
  const used = findAll(part.xml, (e) => Object.entries(e.attrs).some(([k, v]) => k.startsWith('r:') && v === rId)).length > 0;
  if (!used) part.rels.remove(rId);
}

/** Sets a page's own background (null removes it, so the page shows what it inherits). */
export function setBackground(part: PagePart, spec: BackgroundSpec | null, tx: Transaction): void {
  tx.touch(part);
  const cSld = kid(part.xml, 'p:cSld');
  if (!cSld) return;
  const old = at(cSld, 'p:bg/p:bgPr/a:blipFill/a:blip')?.attrs['r:embed'];
  const rId = spec?.kind === 'picture' ? part.rels.add(REL_TYPE.image, spec.media) : '';
  replaceKid(cSld, 'p:bg', spec ? backgroundXml(spec, rId) : null, CSLD_AFTER_BG);
  dropUnusedRel(part, old);
}

/** "Apply to All": the master gets the background, and every slide and layout under it lets its own go, so all show it. */
export function setBackgroundEverywhere(deck: Deck, master: MasterPart, spec: BackgroundSpec, tx: Transaction): void {
  setBackground(master, spec, tx);
  for (const layout of deck.layoutsOf(master)) if (at(layout.xml, 'p:cSld/p:bg')) setBackground(layout, null, tx);
  for (const slide of deck.slides) if (slide.layout.master === master && at(slide.xml, 'p:cSld/p:bg')) setBackground(slide, null, tx);
}

/** The page's own background as a spec, for the dialog to start from (null when it inherits, or has a kind not offered). */
export function backgroundOf(part: PagePart): BackgroundSpec | null {
  const fill = kids(at(part.xml, 'p:cSld/p:bg/p:bgPr'))[0];
  if (!fill) return null;
  const val = (e: XmlElement | undefined): string | null => {
    const v = kid(e, 'a:srgbClr')?.attrs.val;
    return v ? `#${v}` : null;
  };
  if (fill.name === 'a:solidFill') {
    const color = val(fill);
    return color ? { kind: 'solid', color } : null;
  }
  if (fill.name === 'a:gradFill') {
    const stops = kids(kid(fill, 'a:gsLst'), 'a:gs');
    const from = val(stops[0]);
    const to = val(stops[stops.length - 1]);
    if (!from || !to) return null;
    return { kind: 'gradient', from, to, angle: Number(kid(fill, 'a:lin')?.attrs.ang ?? 0) / 60000 };
  }
  return null;
}

// ---- Themes ---------------------------------------------------------------------------------------------------------

/** The twelve colours of a colour scheme, in the theme's order. */
export const SCHEME_NAMES = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'] as const;
export type SchemeName = (typeof SCHEME_NAMES)[number];

export interface ColorScheme {
  /** The id of a built-in scheme (its name is localized), or a scheme's own name (one read from another deck). */
  id: string;
  /** The name written to the theme (`a:clrScheme name`). */
  name: string;
  /** What the dialog shows, when not the name (never written to the file). */
  label?: string;
  colors: Record<SchemeName, string>;
}

export interface FontPair {
  id: string;
  /** The name written to the theme (`a:fontScheme name`). */
  name: string;
  /** What the dialog shows, when not the name (never written to the file). */
  label?: string;
  /** Headings and body text (Latin script). */
  major: string;
  minor: string;
}

const scheme = (id: string, name: string, c: string): ColorScheme => {
  const values = c.split(' ');
  return { id, name, colors: Object.fromEntries(SCHEME_NAMES.map((n, i) => [n, values[i]])) as Record<SchemeName, string> };
};

/** The built-in colour schemes, Office's own first. Names are given in English; the dialog shows them localized by id. */
export const COLOR_SCHEMES: readonly ColorScheme[] = [
  scheme('office', 'Office', '000000 FFFFFF 0E2841 E8E8E8 156082 E97132 196B24 0F9ED5 A02B93 4EA72E 467886 96607D'),
  scheme('office2013', 'Office 2013 - 2022', '000000 FFFFFF 44546A E7E6E6 4472C4 ED7D31 A5A5A5 FFC000 5B9BD5 70AD47 0563C1 954F72'),
  scheme('office2007', 'Office 2007 - 2010', '000000 FFFFFF 1F497D EEECE1 4F81BD C0504D 9BBB59 8064A2 4BACC6 F79646 0000FF 800080'),
  scheme('blue', 'Blue', '000000 FFFFFF 17406D DBEFF9 0F6FC6 009DD9 0BD0D9 10CF9B 7CCA62 A5C249 0563C1 85DFD0'),
  scheme('green', 'Green', '000000 FFFFFF 455F51 E3DED1 549E39 8AB833 C0CF3A 029676 4AB5C4 0989B1 6B9F25 BA6906'),
  scheme('redOrange', 'Red Orange', '000000 FFFFFF 505046 EEECE1 E84C22 FFBD47 B64926 FF8427 CC9900 B22600 CC9900 666699'),
  scheme('violet', 'Violet', '000000 FFFFFF 373545 DCD8DC AD84C6 8784C7 A5B592 F3A447 E7BC29 D092A7 6B9F25 B26B02'),
  scheme('grayscale', 'Grayscale', '000000 FFFFFF 000000 F8F8F8 DDDDDD B2B2B2 969696 808080 5F5F5F 4D4D4D 5F5F5F 919191'),
];

/** The built-in font pairs: families slides are drawn in from the app's own font files (fonts/manifest.json), so they show as picked. */
export const FONT_PAIRS: readonly FontPair[] = [
  { id: 'office', name: 'Office', major: 'Aptos Display', minor: 'Aptos' },
  { id: 'office2013', name: 'Office 2013 - 2022', major: 'Calibri Light', minor: 'Calibri' },
  { id: 'office2007', name: 'Office 2007 - 2010', major: 'Calibri', minor: 'Calibri' },
  { id: 'cambria', name: 'Cambria', major: 'Cambria', minor: 'Calibri' },
  { id: 'cambriaAll', name: 'Cambria', major: 'Cambria', minor: 'Cambria' },
  { id: 'arial', name: 'Arial', major: 'Arial', minor: 'Arial' },
  { id: 'times', name: 'Times New Roman', major: 'Times New Roman', minor: 'Arial' },
  { id: 'segoe', name: 'Segoe UI', major: 'Segoe UI Light', minor: 'Segoe UI' },
];

/** A master's colour scheme and fonts as they are now. */
export function currentDesign(master: MasterPart): { colors: Record<SchemeName, string>; major: string; minor: string; dark: boolean } {
  const colors = Object.fromEntries(SCHEME_NAMES.map((n) => [n, hexOf(master.theme.colors[n] ?? { r: 0, g: 0, b: 0, a: 1 })])) as Record<SchemeName, string>;
  return { colors, major: master.theme.major.latin, minor: master.theme.minor.latin, dark: master.colorMap.bg1 === 'dk1' };
}

/** Whether two colour schemes differ in any of their twelve colours. */
export function colorsDiffer(a: Record<SchemeName, string>, b: Record<SchemeName, string>): boolean {
  return SCHEME_NAMES.some((n) => hex(a[n] ?? '') !== hex(b[n] ?? ''));
}

/** The colour a scheme entry holds now (`srgbClr`, or a system colour's last value), as RRGGBB. */
function heldColor(holder: XmlElement | undefined): string | null {
  const v = kid(holder, 'a:srgbClr')?.attrs.val ?? kid(holder, 'a:sysClr')?.attrs.lastClr;
  return v ? hex(v) : null;
}

/** Puts a colour scheme in a theme part (`a:clrScheme`): each colour that differs becomes a plain RGB value. */
export function setThemeColors(themePart: DeckPart, colors: ColorScheme, tx: Transaction): void {
  const clrScheme = at(themePart.xml, 'a:themeElements/a:clrScheme');
  if (!clrScheme) return;
  tx.touch(themePart);
  clrScheme.attrs = { ...clrScheme.attrs, name: colors.name };
  for (const name of SCHEME_NAMES) {
    const value = hex(colors.colors[name]);
    let holder = kid(clrScheme, `a:${name}`);
    // A colour left as it was keeps how it is written (a system colour stays one).
    if (holder && heldColor(holder) === value) continue;
    if (!holder) {
      holder = el(`a:${name}`);
      insertBefore(clrScheme, holder, ['a:extLst', ...SCHEME_NAMES.slice(SCHEME_NAMES.indexOf(name) + 1).map((n) => `a:${n}`)]);
    }
    holder.children = [el('a:srgbClr', { val: value })];
  }
}

/** Puts a font pair in a theme part (`a:fontScheme`): the Latin typeface of its heading and body fonts. */
export function setThemeFonts(themePart: DeckPart, fonts: FontPair, tx: Transaction): void {
  const fontScheme = at(themePart.xml, 'a:themeElements/a:fontScheme');
  if (!fontScheme) return;
  tx.touch(themePart);
  fontScheme.attrs = { ...fontScheme.attrs, name: fonts.name };
  for (const [which, typeface] of [['a:majorFont', fonts.major], ['a:minorFont', fonts.minor]] as const) {
    const font = kid(fontScheme, which);
    if (!font) continue;
    const latin = kid(font, 'a:latin');
    // A typeface left as it was keeps its panose, pitch and charset.
    if (latin?.attrs.typeface === typeface) continue;
    if (latin) latin.attrs = { typeface };
    else font.children.unshift(el('a:latin', { typeface }));
  }
}

/** The colour map of a light page (text dark on light) and of a dark one (light on dark). */
const LIGHT_MAP = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
const DARK_MAP = { bg1: 'dk1', tx1: 'lt1', bg2: 'dk2', tx2: 'lt2' };

/** Makes a master's pages dark (its background the scheme's dark colour, its text the light one) or light, by its colour map. */
export function setDarkPages(master: MasterPart, dark: boolean, tx: Transaction): void {
  const map = kid(master.xml, 'p:clrMap');
  if (!map) return;
  tx.touch(master);
  map.attrs = { ...map.attrs, ...(dark ? DARK_MAP : LIGHT_MAP) };
}

/**
 * Slide › Theme's answer, applied: the colours and fonts go to `master`'s theme only, and only those changed from what it
 * has now (another master keeps its own theme, and what was left alone is written as it was); light or dark pages go to every
 * master. `themeMissing`: colours or fonts were asked for but the master has no theme part to put them in.
 */
export function applyTheme(deck: Deck, master: MasterPart, answer: { colors: ColorScheme; fonts: FontPair; dark: boolean }, tx: Transaction): { themeMissing: boolean } {
  const now = currentDesign(master);
  const colorsChanged = colorsDiffer(answer.colors.colors, now.colors);
  const fontsChanged = answer.fonts.major !== now.major || answer.fonts.minor !== now.minor;
  const theme = deck.themePart(master);
  if (theme && colorsChanged) setThemeColors(theme, answer.colors, tx);
  if (theme && fontsChanged) setThemeFonts(theme, answer.fonts, tx);
  for (const m of deck.masters) if ((m.colorMap.bg1 === 'dk1') !== answer.dark) setDarkPages(m, answer.dark, tx);
  deck.refreshThemes();
  return { themeMissing: (colorsChanged || fontsChanged) && !theme };
}

/** The colours and fonts of another deck's (or a theme file's) theme, to apply to this one. Null if it has none. */
export async function readOtherTheme(bytes: Uint8Array, name: string): Promise<{ colors: ColorScheme; fonts: FontPair } | null> {
  const pkg = await OpcPackage.read(bytes);
  // A theme file (.thmx) points at its theme from the package; a deck, from its first master.
  const root = await pkg.relationships('');
  let themeName = '';
  const main = root.byType(REL_TYPE.officeDocument)[0];
  if (main) {
    const mainName = root.partName(main);
    const mainXml = parseXml(await pkg.text(mainName));
    if (mainXml.name === 'a:theme') themeName = mainName;
    else {
      const rels = await pkg.relationships(mainName);
      const masterRel = rels.byType(REL_TYPE.slideMaster)[0] ?? rels.byType(REL_TYPE.theme)[0];
      if (masterRel && isRelOf(masterRel.type, REL_TYPE.theme)) themeName = rels.partName(masterRel);
      else if (masterRel) {
        const masterName = rels.partName(masterRel);
        const themeRel = (await pkg.relationships(masterName)).byType(REL_TYPE.theme)[0];
        if (themeRel) themeName = (await pkg.relationships(masterName)).partName(themeRel);
      }
    }
  }
  if (!themeName || !pkg.has(themeName)) return null;
  const xml = parseXml(await pkg.text(themeName));
  if (!at(xml, 'a:themeElements/a:clrScheme')) return null;
  const theme = readTheme(xml);
  const label = at(xml, 'a:themeElements/a:clrScheme')?.attrs.name || theme.name || name;
  const colors = Object.fromEntries(SCHEME_NAMES.map((n) => [n, hexOf(theme.colors[n])])) as Record<SchemeName, string>;
  const fontLabel = at(xml, 'a:themeElements/a:fontScheme')?.attrs.name || theme.name || name;
  return { colors: { id: `file:${name}`, name: label, colors }, fonts: { id: `file:${name}`, name: fontLabel, major: theme.major.latin, minor: theme.minor.latin } };
}

const isRelOf = (type: string, wanted: string): boolean => type === wanted || type.endsWith(wanted.slice(wanted.lastIndexOf('/')));

// ---- Master and layout text styles ------------------------------------------------------------------------------------

/**
 * The list style that a placeholder on a master or layout passes to every slide that inherits it: on a master, its text
 * style for its title or body placeholders (`p:titleStyle`, `p:bodyStyle`); otherwise (a layout's placeholder, a master's
 * date, footer or slide number) the placeholder's own list style. Made when missing (with `create`). Undefined for a slide, or a shape that is not a placeholder.
 */
export function inheritedStyleOf(part: PagePart, element: XmlElement, create: boolean): XmlElement | undefined {
  if (isSlidePart(part)) return undefined;
  const ph = placeholderOf(element);
  if (!ph) return undefined;
  // A master's title and body placeholders pass on its title and body styles. Its others (date, footer, slide number...)
  // pass on their own list style, as a layout's do: `p:otherStyle` is the text of every shape and text box, not theirs.
  const which = isMasterPart(part) ? masterStyleFor(ph.type) : null;
  if (which === 'p:titleStyle' || which === 'p:bodyStyle') {
    const styles = kid(part.xml, 'p:txStyles') ?? (create ? addKid(part.xml, 'p:txStyles', ['p:extLst']) : undefined);
    if (!styles) return undefined;
    return kid(styles, which) ?? (create ? addKid(styles, which, which === 'p:titleStyle' ? ['p:bodyStyle', 'p:otherStyle', 'p:extLst'] : which === 'p:bodyStyle' ? ['p:otherStyle', 'p:extLst'] : ['p:extLst']) : undefined);
  }
  if (!isLayoutPart(part) && !isMasterPart(part)) return undefined;
  const body = kid(element, 'p:txBody');
  if (!body) return undefined;
  return kid(body, 'a:lstStyle') ?? (create ? addKid(body, 'a:lstStyle', ['a:p']) : undefined);
}

function addKid(parent: XmlElement, name: string, before: readonly string[]): XmlElement {
  const made = el(name);
  insertBefore(parent, made, before);
  return made;
}
