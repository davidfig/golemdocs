// A deck (docs/slides.md): the `.pptx` package with every part the slides need already parsed, so that drawing a slide never
// waits. The XML of each part is the model: the editor changes it in place, marks the part changed, and writing puts only the
// changed parts back, so open then save leaves every other part as it came.
//
// Slides, layouts and masters are found by following relationships: presentation → slide (in `p:sldIdLst` order) → layout →
// master → theme; a slide's notes and the drawings, charts and pictures it uses hang off its own relationships.

import { OpcPackage, Relationships, cloneElement, el, isRelType, parseXml, serializeXml, type Relationship, type XmlElement } from '@golemdocs/docx';
import { CONTENT, REL_TYPE, at, kid, kids, num } from './ooxml.ts';
import { DEFAULT_MAP } from '../drawingml/color.ts';
import { defaultTheme, readTheme, type Theme } from '../drawingml/theme.ts';

export interface DeckPart {
  name: string;
  xml: XmlElement;
  rels: Relationships;
}

export interface MasterPart extends DeckPart {
  theme: Theme;
  /** `bg1` → `lt1`... */
  colorMap: Record<string, string>;
}

export interface LayoutPart extends DeckPart {
  master: MasterPart;
}

export interface SlidePart extends DeckPart {
  /** The slide's id in `p:sldIdLst` (stays with it when slides move). */
  id: number;
  layout: LayoutPart;
  notes: DeckPart | null;
}

/** What the editor shows and edits as a page: a slide, or (in master view) a master or one of its layouts. */
export type PagePart = SlidePart | LayoutPart | MasterPart;

export const isSlidePart = (part: DeckPart): part is SlidePart => 'layout' in part;
export const isLayoutPart = (part: DeckPart): part is LayoutPart => 'master' in part && !('layout' in part);
export const isMasterPart = (part: DeckPart): part is MasterPart => 'theme' in part && 'colorMap' in part;

/** The master a page takes after (a master is its own). */
export function masterOfPage(part: PagePart): MasterPart {
  return isSlidePart(part) ? part.layout.master : isLayoutPart(part) ? part.master : part;
}

export class DeckError extends Error {}

/** Parts a slide may point at whose XML is read up front, so drawing never waits for them. */
const XML_RELS = [REL_TYPE.chart, REL_TYPE.diagramDrawing];

function colorMapOf(element: XmlElement | undefined): Record<string, string> {
  if (!element) return { ...DEFAULT_MAP };
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(element.attrs)) if (!k.startsWith('xmlns')) map[k] = v;
  return { ...DEFAULT_MAP, ...map };
}

export class Deck {
  /** Every part read so far, by name. */
  private readonly parts = new Map<string, DeckPart>();
  /** Parts changed since the deck was read or last written. */
  readonly dirty = new Set<string>();
  /** Media bytes by part name, once read. */
  private readonly media = new Map<string, Promise<Uint8Array>>();
  presentation!: DeckPart;
  slides: SlidePart[] = [];
  masters: MasterPart[] = [];
  notesMaster: DeckPart | null = null;
  /** Slide size in EMU. */
  width = 12192000;
  height = 6858000;
  /** The table styles part (`ppt/tableStyles.xml`), if any. */
  tableStyles: XmlElement | null = null;

  private constructor(readonly pkg: OpcPackage) {}

  static async read(bytes: Uint8Array): Promise<Deck> {
    let pkg: OpcPackage;
    try {
      pkg = await OpcPackage.read(bytes);
    } catch (e) {
      throw new DeckError((e as Error).message);
    }
    const deck = new Deck(pkg);
    const root = await pkg.relationships('');
    const main = root.byType(REL_TYPE.officeDocument)[0];
    if (!main) throw new DeckError('not a presentation: it has no main part');
    deck.presentation = await deck.load(root.partName(main));
    if (deck.presentation.xml.name !== 'p:presentation') throw new DeckError('not a presentation');
    const size = kid(deck.presentation.xml, 'p:sldSz');
    deck.width = num(size, 'cx') ?? deck.width;
    deck.height = num(size, 'cy') ?? deck.height;
    for (const ref of kids(kid(deck.presentation.xml, 'p:sldMasterIdLst'), 'p:sldMasterId')) {
      const rel = deck.presentation.rels.byId(ref.attrs['r:id'] ?? '');
      if (rel) await deck.loadMaster(deck.presentation.rels.partName(rel));
    }
    const notesMaster = deck.presentation.rels.byType(REL_TYPE.notesMaster)[0];
    if (notesMaster) deck.notesMaster = await deck.load(deck.presentation.rels.partName(notesMaster));
    const tableStyles = deck.presentation.rels.list.find((r) => r.type.endsWith('/tableStyles'));
    if (tableStyles) deck.tableStyles = (await deck.load(deck.presentation.rels.partName(tableStyles))).xml;
    await deck.loadSlides();
    return deck;
  }

  /** Reads and parses a part (once), with its relationships. */
  async load(name: string): Promise<DeckPart> {
    const known = this.parts.get(name);
    if (known) return known;
    if (!this.pkg.has(name)) throw new DeckError(`missing part ${name}`);
    const part: DeckPart = { name, xml: parseXml(await this.pkg.text(name)), rels: await this.pkg.relationships(name) };
    this.parts.set(name, part);
    return part;
  }

  /** A part already read; undefined if it never was. */
  part(name: string): DeckPart | undefined {
    return this.parts.get(name);
  }

  private async loadMaster(name: string): Promise<MasterPart> {
    const known = this.masters.find((m) => m.name === name);
    if (known) return known;
    const part = await this.load(name);
    const themeRel = part.rels.byType(REL_TYPE.theme)[0];
    const theme = themeRel ? readTheme((await this.load(part.rels.partName(themeRel))).xml) : defaultTheme();
    const master: MasterPart = Object.assign(part, { theme, colorMap: colorMapOf(kid(part.xml, 'p:clrMap')) });
    this.masters.push(master);
    for (const rel of part.rels.byType(REL_TYPE.slideLayout)) await this.loadLayout(part.rels.partName(rel), master);
    await this.loadAttached(master);
    return master;
  }

  private readonly layoutsByName = new Map<string, LayoutPart>();

  private async loadLayout(name: string, master?: MasterPart): Promise<LayoutPart> {
    const known = this.layoutsByName.get(name);
    if (known) return known;
    const part = await this.load(name);
    if (!master) {
      const rel = part.rels.byType(REL_TYPE.slideMaster)[0];
      if (!rel) throw new DeckError(`${name} has no master`);
      master = await this.loadMaster(part.rels.partName(rel));
    }
    const layout: LayoutPart = Object.assign(part, { master });
    this.layoutsByName.set(name, layout);
    await this.loadAttached(layout);
    return layout;
  }

  /** The theme part a master uses (undefined when it has none). */
  themePart(master: MasterPart): DeckPart | undefined {
    const rel = master.rels.byType(REL_TYPE.theme)[0];
    return rel ? this.parts.get(master.rels.partName(rel)) : undefined;
  }

  /** Reads every master's theme and colour map again from their XML (after a theme was changed, or put back by an undo). */
  refreshThemes(): void {
    for (const master of this.masters) {
      master.theme = readTheme(this.themePart(master)?.xml);
      master.colorMap = colorMapOf(kid(master.xml, 'p:clrMap'));
    }
  }

  /** The layouts of a master, in its own order. */
  layoutsOf(master: MasterPart): LayoutPart[] {
    const out: LayoutPart[] = [];
    for (const ref of kids(kid(master.xml, 'p:sldLayoutIdLst'), 'p:sldLayoutId')) {
      const rel = master.rels.byId(ref.attrs['r:id'] ?? '');
      const layout = rel && this.layoutsByName.get(master.rels.partName(rel));
      if (layout) out.push(layout);
    }
    return out;
  }

  /** Reads the charts and diagram drawings a part uses. */
  private async loadAttached(part: DeckPart): Promise<void> {
    for (const rel of part.rels.list) {
      if (rel.external || !XML_RELS.some((t) => isRelType(rel.type, t))) continue;
      const name = part.rels.partName(rel);
      if (this.pkg.has(name)) await this.load(name).catch(() => undefined);
    }
  }

  /** The slides, in the order `p:sldIdLst` gives (call again after that list or its relationships change). */
  async loadSlides(): Promise<void> {
    const slides: SlidePart[] = [];
    for (const ref of kids(kid(this.presentation.xml, 'p:sldIdLst'), 'p:sldId')) {
      const rel = this.presentation.rels.byId(ref.attrs['r:id'] ?? '');
      if (!rel) continue;
      const name = this.presentation.rels.partName(rel);
      const part = await this.load(name).catch(() => null);
      if (!part) continue;
      slides.push(await this.slidePart(part, Number(ref.attrs.id) || 0));
    }
    this.slides = slides;
  }

  private readonly slideParts = new Map<string, SlidePart>();

  private async slidePart(part: DeckPart, id: number): Promise<SlidePart> {
    const known = this.slideParts.get(part.name);
    if (known) {
      // Its layout or notes may have changed (or been put back by an undo).
      known.id = id;
      const layoutRel = known.rels.byType(REL_TYPE.slideLayout)[0];
      if (layoutRel) known.layout = await this.loadLayout(known.rels.partName(layoutRel));
      const notesRel = known.rels.byType(REL_TYPE.notesSlide)[0];
      known.notes = notesRel ? await this.load(known.rels.partName(notesRel)).catch(() => null) : null;
      return known;
    }
    const layoutRel = part.rels.byType(REL_TYPE.slideLayout)[0];
    const layout = layoutRel ? await this.loadLayout(part.rels.partName(layoutRel)) : this.layoutsOf(this.masters[0])[0];
    if (!layout) throw new DeckError(`${part.name} has no layout`);
    const notesRel = part.rels.byType(REL_TYPE.notesSlide)[0];
    const notes = notesRel ? await this.load(part.rels.partName(notesRel)).catch(() => null) : null;
    await this.loadAttached(part);
    const slide: SlidePart = Object.assign(part, { id, layout, notes });
    this.slideParts.set(part.name, slide);
    return slide;
  }

  /** The colour map a slide's shapes use (its own override, else its layout's, else its master's). */
  colorMap(part: SlidePart | LayoutPart | MasterPart): Record<string, string> {
    const master = 'master' in part ? part.master : 'layout' in part ? part.layout.master : (part as MasterPart);
    for (const p of 'layout' in part ? [part, part.layout] : [part]) {
      const override = kid(kid(p.xml, 'p:clrMapOvr'), 'a:overrideClrMapping');
      if (override) return colorMapOf(override);
    }
    return master.colorMap;
  }

  /** A picture's or medium's bytes, by part name (read once). */
  bytes(name: string): Promise<Uint8Array> {
    let found = this.media.get(name);
    if (!found) {
      found = this.pkg.bytes(name);
      this.media.set(name, found);
    }
    return found;
  }

  /** The part a relationship of a part points at ('' for an external or missing one). */
  target(part: DeckPart, rId: string | undefined): string {
    const rel = rId ? part.rels.byId(rId) : undefined;
    return rel && !rel.external ? part.rels.partName(rel) : '';
  }

  /** The text of the slide's notes (the body placeholder's paragraphs). */
  notesText(slide: SlidePart): string {
    const tree = at(slide.notes?.xml, 'p:cSld/p:spTree');
    for (const sp of kids(tree, 'p:sp')) {
      const ph = at(sp, 'p:nvSpPr/p:nvPr/p:ph');
      if (ph?.attrs.type !== 'body') continue;
      return kids(kid(sp, 'p:txBody'), 'a:p')
        .map((p) => paragraphText(p))
        .join('\n');
    }
    return '';
  }

  markDirty(part: DeckPart): void {
    this.dirty.add(part.name);
  }

  /** The deck as a `.pptx`. */
  async write(): Promise<Uint8Array> {
    for (const name of this.dirty) {
      const part = this.parts.get(name);
      if (part) this.pkg.set(name, serializeXml(part.xml), contentTypeOf(name));
    }
    this.dirty.clear();
    return this.pkg.write({ unreachableUnder: ['ppt/slides/', 'ppt/notesSlides/', 'ppt/media/', 'ppt/charts/', 'ppt/embeddings/', 'ppt/diagrams/'] });
  }

  // ---- Changing the deck's structure (the editor records these for undo, see edits.ts) -------------------------------

  /** Adds a part (or replaces its XML), marked changed. */
  async addPart(name: string, xml: XmlElement): Promise<DeckPart> {
    let part = this.parts.get(name);
    if (part) part.xml = xml;
    else {
      this.pkg.set(name, serializeXml(xml), contentTypeOf(name));
      part = { name, xml, rels: await this.pkg.relationships(name) };
      this.parts.set(name, part);
    }
    this.dirty.add(name);
    return part;
  }

  /** Adds a media part (a picture), named after its content, and returns its name. */
  addMedia(bytes: Uint8Array, extension: string): string {
    const name = this.pkg.uniqueName('ppt/media/image', extension);
    const type = extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : extension === 'svg' ? 'image/svg+xml' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
    this.pkg.setDefaultContentType(extension, type);
    this.pkg.set(name, bytes);
    this.media.set(name, Promise.resolve(bytes));
    return name;
  }

  uniqueName(prefix: string, extension: string): string {
    let n = 1;
    for (;;) {
      const name = `${prefix}${n}.${extension}`;
      if (!this.pkg.has(name) && !this.parts.has(name)) return name;
      n++;
    }
  }
}

export function contentTypeOf(name: string): string | undefined {
  if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) return CONTENT.slide;
  if (/^ppt\/slideLayouts\//.test(name)) return CONTENT.slideLayout;
  if (/^ppt\/slideMasters\//.test(name)) return CONTENT.slideMaster;
  if (/^ppt\/notesSlides\//.test(name)) return CONTENT.notesSlide;
  if (/^ppt\/notesMasters\//.test(name)) return CONTENT.notesMaster;
  if (/^ppt\/theme\//.test(name)) return CONTENT.theme;
  if (name === 'ppt/presentation.xml') return CONTENT.presentation;
  return undefined;
}

/** The plain text of a paragraph (`a:p`): its runs, fields and line breaks. */
export function paragraphText(p: XmlElement): string {
  let text = '';
  for (const c of kids(p)) {
    if (c.name === 'a:r' || c.name === 'a:fld') text += kids(c, 'a:t').map((t) => ownTextOf(t)).join('');
    else if (c.name === 'a:br') text += '\u000b';
  }
  return text;
}

function ownTextOf(t: XmlElement): string {
  let s = '';
  for (const c of t.children) if (typeof c === 'string') s += c;
  return s;
}

/** A snapshot of a part (its XML and relationships), to put back on undo. */
export interface PartState {
  name: string;
  xml: XmlElement | null;
  rels: Relationship[];
}

export function snapshotPart(deck: Deck, name: string): PartState {
  const part = deck.part(name);
  return { name, xml: part ? cloneElement(part.xml) : null, rels: part ? part.rels.list.map((r) => ({ ...r })) : [] };
}

/** Puts a part back as a snapshot had it (a part that did not exist is emptied: nothing points at it any more). */
export function restorePart(deck: Deck, state: PartState): void {
  const part = deck.part(state.name);
  if (!part) return;
  part.xml = state.xml ? cloneElement(state.xml) : el('p:sld');
  part.rels.list.splice(0, part.rels.list.length, ...state.rels.map((r) => ({ ...r })));
  // Marks the relationships changed, so they are written as they now are.
  const probe = part.rels.add('urn:golem:probe', 'urn:golem:probe', true);
  part.rels.remove(probe);
  deck.markDirty(part);
}
