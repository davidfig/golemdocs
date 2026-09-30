// Document layout: sections, pagination, headers and footers, and incremental re-layout.
//
// Every page records the pagination state where its body starts (PageStart). After an edit,
// layout restarts from the page before the first changed paragraph and stops as soon as a
// page starts in the same state as a page of the previous layout past every change: from
// there on the old pages are still right and are kept (moved, if the page count changed).
// An edit that shifts everything after it (a new line early in a long document) re-paginates
// to the end in slices, pages nearest the edit first, and a newer edit supersedes it.

import {
  ListCounter,
  StyleResolver,
  isMathInline,
  type HeaderFooterReference,
  type Inline,
  type ListState,
  type Paragraph,
  type RunProperties,
  type SectionProperties,
  type Table,
  type WordDocument,
} from '@word/docx';
import { packColor, PageLayout, type LineRecord } from './display.ts';
import { FALLBACK_FAMILY, type FontSet } from './fonts/fontSet.ts';
import type { ManifestFace } from './fonts/fontTypes.ts';
import { cjkLangOf, type FieldValues, type LayoutContext, type RunStyle } from './context.ts';
import type { CjkLang } from './fonts/cjk.ts';
import { REFLOW_SIDE, REFLOW_VERTICAL, reflowWidth } from './reflow.ts';
import { emitLine, layoutParagraph, type CachedParagraph, type FloatSpec, type ParagraphLayout } from './paragraph.ts';
import { clearTableStyles, cutBox, emitBox, emitRow, emitRowSlice, flattenBlocks, layoutBox, layoutTable, type BoxLayout, type TableLayout } from './table.ts';

const twips = (v: number | undefined, fallback: number) => (v ?? fallback) / 20;

/** The cut just after the first item at or below `from` (forces progress on an overfull page). */
function nextItemEnd(box: BoxLayout, from: number): number {
  const items = box.items.filter((item) => item.y >= from - 0.01);
  return items.length > 1 ? items[1].y : box.height;
}

/** Page geometry of a section, in points. */
export interface SectionGeometry {
  properties: SectionProperties;
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  header: number;
  footer: number;
  contentWidth: number;
  /** Columns of text (1 for an ordinary page): how many, the gap between them, and the width of each (points). Equal widths only. */
  columns: number;
  columnGap: number;
  columnWidth: number;
  /** Header/footer parts by kind, inherited from earlier sections where missing. */
  headers: Partial<Record<HeaderFooterReference['type'], string>>;
  footers: Partial<Record<HeaderFooterReference['type'], string>>;
}

export interface DocumentLayout {
  pages: PageLayout[];
  sections: SectionGeometry[];
  /** Milliseconds spent in each phase. */
  timings: { fonts: number; body: number; headers: number };
}

type Block = Paragraph | Table;
type BlockLayout = ParagraphLayout | TableLayout;

/** What pagination needs to know about the block before the current one. */
interface PreviousBlock {
  styleId?: string;
  contextualSpacing: boolean;
  keepNext: boolean;
}

/** Pagination state where a page's body begins: enough to lay out from this page on. */
export interface PageStart {
  section: number;
  /**
   * Index of the block the page begins in, within its section, when the page was laid out
   * (edits earlier in the document shift it: `block` is authoritative).
   */
  blockIndex: number;
  block: Block | null;
  /** Paragraph line to continue at (0: the block starts on this page). */
  line: number;
  /** Table row to continue at. */
  row: number;
  /** Table header rows repeat at the top of this page. */
  repeatHeaders: boolean;
  /** Layout can restart here (not inside a table row split across pages, nor on a blank page). */
  restartable: boolean;
  /** The page began because content overflowed (space before is suppressed). */
  natural: boolean;
  pendingAfter: number;
  previous: PreviousBlock | null;
  /** List counters before `block` is laid out. */
  lists: ListState;
  number: number;
  firstOfSection: boolean;
  /** Body area. */
  top: number;
  bottom: number;
}

function geometry(props: SectionProperties, previous: SectionGeometry | undefined): SectionGeometry {
  const reflow = reflowWidth();
  if (reflow !== null) {
    const height = twips(props.pageSize?.h, 15840);
    const contentWidth = Math.max(reflow - 2 * REFLOW_SIDE, 36);
    return {
      properties: props,
      width: reflow,
      height,
      top: REFLOW_VERTICAL,
      bottom: REFLOW_VERTICAL,
      left: REFLOW_SIDE,
      right: REFLOW_SIDE,
      header: 0,
      footer: 0,
      contentWidth,
      columns: 1,
      columnGap: 0,
      columnWidth: contentWidth,
      headers: {},
      footers: {},
    };
  }
  const width = twips(props.pageSize?.w, 12240);
  const height = twips(props.pageSize?.h, 15840);
  const m = props.margins ?? {};
  const left = twips(m.left, 1440) + twips(m.gutter, 0);
  const right = twips(m.right, 1440);
  const inherit = (refs: HeaderFooterReference[], prev: SectionGeometry['headers'] | undefined) => {
    const out = { ...(prev ?? {}) };
    for (const ref of refs) out[ref.type] = ref.part;
    return out;
  };
  const contentWidth = Math.max(width - left - right, 36);
  const columns = Math.max(1, Math.min(Math.floor(props.columns?.num ?? 1), 12));
  const columnGap = columns > 1 ? Math.max(twips(props.columns?.space, 720), 0) : 0;
  return {
    properties: props,
    width,
    height,
    top: twips(m.top, 1440),
    bottom: twips(m.bottom, 1440),
    left,
    right,
    header: twips(m.header, 720),
    footer: twips(m.footer, 720),
    contentWidth,
    columns,
    columnGap,
    columnWidth: Math.max((contentWidth - columnGap * (columns - 1)) / columns, 36),
    headers: inherit(props.headers, previous?.headers),
    footers: inherit(props.footers, previous?.footers),
  };
}

interface SectionBlocks {
  properties: SectionProperties;
  blocks: Block[];
}

/** Splits the body into sections: each ends at a paragraph carrying section properties. */
function splitSections(doc: WordDocument): SectionBlocks[] {
  const sections: SectionBlocks[] = [];
  let blocks: Block[] = [];
  for (const block of flattenBlocks(doc.body)) {
    blocks.push(block);
    if (block.kind === 'paragraph' && block.properties.section) {
      sections.push({ properties: block.properties.section, blocks });
      blocks = [];
    }
  }
  sections.push({ properties: doc.section, blocks });
  return sections;
}

// --- Fonts -------------------------------------------------------------------------------

/** Every face the document can need, so layout itself never waits on loading. */
function facesFor(doc: WordDocument, resolver: StyleResolver, fonts: FontSet): Set<ManifestFace> {
  const names = new Set<string>([FALLBACK_FAMILY]);
  const addFonts = (props: RunProperties | undefined) => {
    const name = props?.fonts && resolver.font(props.fonts);
    if (name) names.add(name);
  };
  addFonts(doc.styles.defaultRunProperties);
  for (const style of doc.styles.styles) {
    addFonts(style.runProperties);
    addFonts(style.paragraphProperties?.runProperties);
    for (const c of style.tableConditions ?? []) addFonts(c.runProperties);
  }
  for (const a of doc.numbering.abstracts) for (const l of a.levels) addFonts(l.runProperties);
  for (const n of doc.numbering.instances) for (const o of n.overrides) addFonts(o.definition?.runProperties);
  if (doc.theme.major.latin) names.add(doc.theme.major.latin);
  if (doc.theme.minor.latin) names.add(doc.theme.minor.latin);

  const stack: unknown[] = [...doc.body];
  for (const hf of doc.headersFooters.values()) stack.push(...hf.children);
  while (stack.length) {
    const node = stack.pop() as { kind: string; [key: string]: any };
    switch (node.kind) {
      case 'paragraph':
        addFonts(node.properties.runProperties);
        stack.push(...node.children);
        break;
      case 'run':
        addFonts(node.properties);
        break;
      case 'hyperlink':
      case 'wrapper':
      case 'cell':
        stack.push(...node.children);
        break;
      case 'table':
        stack.push(...node.rows);
        break;
      case 'row':
        stack.push(...node.cells);
        break;
    }
  }

  const faces = new Set<ManifestFace>();
  for (const name of names) {
    for (const bold of [false, true]) for (const italic of [false, true]) faces.add(fonts.resolve({ font: name, bold, italic }).face);
  }
  return faces;
}

/** Whether the document has an equation anywhere in its body, headers or footers. */
function hasMath(doc: WordDocument): boolean {
  const stack: unknown[] = [...doc.body];
  for (const hf of doc.headersFooters.values()) stack.push(...hf.children);
  while (stack.length) {
    const node = stack.pop() as { kind: string; [key: string]: any };
    switch (node.kind) {
      case 'raw':
        if (isMathInline(node as Inline)) return true;
        break;
      case 'paragraph':
      case 'hyperlink':
      case 'wrapper':
      case 'cell':
        stack.push(...node.children);
        break;
      case 'table':
        stack.push(...node.rows);
        break;
      case 'row':
        stack.push(...node.cells);
        break;
    }
  }
  return false;
}

const CJK_TEXT = /[\u1100-\u11ff\u3000-\u30ff\u3100-\u312f\u31a0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\ua960-\ua97f\uac00-\ud7ff]/;

/** Adds the CJK characters of a string to a set. */
function addCjk(text: string, into: Set<number>): void {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x1100 && CJK_TEXT.test(text[i])) into.add(c);
  }
}

/**
 * The CJK characters in the document's text (body, headers and footers), by the language of the
 * run they are in, so the pages that draw them can be loaded before layout.
 */
function cjkTextOf(doc: WordDocument, resolver: StyleResolver, fonts: FontSet): Map<CjkLang, Set<number>> {
  const found = new Map<CjkLang, Set<number>>();
  const ctx = { resolver, fonts };
  const visit = (node: { kind: string; [key: string]: any }, paragraphStyle: string | undefined): void => {
    switch (node.kind) {
      case 'run': {
        let chars: Set<number> | undefined;
        for (const item of node.content as { kind: string; text?: string }[]) {
          if (item.kind !== 'text' || !item.text || !CJK_TEXT.test(item.text)) continue;
          chars ??= new Set();
          addCjk(item.text, chars);
        }
        if (!chars) break;
        const lang = cjkLangOf(ctx, resolver.run(paragraphStyle, node.properties));
        const into = found.get(lang);
        if (into) for (const c of chars) into.add(c);
        else found.set(lang, chars);
        break;
      }
      case 'paragraph':
        for (const child of node.children) visit(child, node.properties.style);
        break;
      case 'hyperlink':
      case 'wrapper':
      case 'cell':
        for (const child of node.children) visit(child, paragraphStyle);
        break;
      case 'table':
        for (const row of node.rows) visit(row, paragraphStyle);
        break;
      case 'row':
        for (const cell of node.cells) visit(cell, paragraphStyle);
        break;
    }
  };
  for (const block of doc.body) visit(block as any, undefined);
  for (const hf of doc.headersFooters.values()) for (const block of hf.children) visit(block as any, undefined);
  return found;
}

/** Whether header/footer content has fields (its layout then depends on page numbers). */
function hasFields(blocks: readonly unknown[]): boolean {
  const stack = [...blocks] as { kind: string; [key: string]: any }[];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind === 'run' && (node.content as { kind: string }[]).some((c) => c.kind === 'fieldChar')) return true;
    if (node.kind === 'wrapper' && node.shell?.name === 'w:fldSimple') return true;
    if (node.kind === 'paragraph' || node.kind === 'hyperlink' || node.kind === 'wrapper' || node.kind === 'cell') stack.push(...(node.children as Inline[]));
    else if (node.kind === 'table') stack.push(...node.rows);
    else if (node.kind === 'row') stack.push(...node.cells);
  }
  return false;
}

// --- Options -----------------------------------------------------------------------------

/**
 * Streaming hooks. Without them layout runs to completion and returns every page; with them
 * a caller (a worker, a server) can ship pages as they're finished, stay responsive, and
 * abandon a layout that's no longer wanted.
 */
export interface LayoutOptions {
  /**
   * A page's body is final. Called in page order, before the page gets its header and
   * footer (those need the page count, so they're laid out once the body is done).
   */
  onPage?: (page: PageLayout) => void;
  /**
   * A page's header and footer, laid out into a separate overlay. After this call the
   * overlay is also merged into the page (unless mergeOverlays is false), so the returned
   * layout is complete either way.
   */
  onHeaderFooter?: (page: PageLayout, overlay: PageLayout) => void;
  /**
   * Merge header/footer overlays into their pages (default true). A streaming caller that
   * hands page buffers off in onPage (see encodePage) turns this off.
   */
  mergeOverlays?: boolean;
  /**
   * Called about every `sliceMs` of work, and awaited: flush output, yield to the event
   * loop. Pages finished so far have been passed to onPage before it's called.
   */
  onSlice?: () => Promise<void> | void;
  /** Milliseconds of work between onSlice calls (default 8). */
  sliceMs?: number;
  /** Checked after each slice; an aborted layout rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** What a finished (or superseded) run did. */
export interface RunResult {
  /** False if an invalidate() during a slice superseded this run; nothing was committed. */
  completed: boolean;
  /** First page index laid out again (pages before it were kept as they were). */
  from: number;
  /** Pages laid out by this run, now in `pages`. */
  added: PageLayout[];
  /** Pages of the previous layout that are gone. */
  removed: PageLayout[];
  /** Pages kept from the previous layout but moved (their index changed). */
  moved: number;
  /** Where the run stopped because the rest matched the previous layout (-1 if it ran to the end). */
  convergedAt: number;
}

// --- Blocks ------------------------------------------------------------------------------

/**
 * A section's blocks, laid out on first use and strictly in order (list numbering advances
 * as blocks are laid out). Pagination walks forward with a small lookahead (keep-with-next
 * chains), so only a window of block layouts is alive at a time.
 */
class LazyBlocks {
  private readonly cache = new Map<number, BlockLayout>();
  /** List counters before each block in the window was laid out. */
  private readonly listsBefore = new Map<number, ListState>();
  private frontier: number;

  constructor(
    private readonly source: Block[],
    private readonly ctx: LayoutContext,
    private readonly width: number,
    first: number,
  ) {
    this.frontier = first;
  }

  get length(): number {
    return this.source.length;
  }

  block(i: number): Block | null {
    return this.source[i] ?? null;
  }

  get(i: number): BlockLayout {
    let layout = this.cache.get(i);
    if (!layout) {
      if (i !== this.frontier) throw new Error(`blocks laid out out of order (${i}, expected ${this.frontier})`);
      if (this.ctx.lists) this.listsBefore.set(i, this.ctx.lists.snapshot());
      const b = this.source[i];
      layout = b.kind === 'paragraph' ? layoutParagraph(b, this.ctx, this.width) : layoutTable(b, this.ctx, this.width);
      this.cache.set(i, layout);
      this.frontier = i + 1;
    }
    return layout;
  }

  /** List counters before block i. */
  listsAt(i: number): ListState {
    const saved = this.listsBefore.get(i);
    if (saved) return saved;
    if (i !== this.frontier || !this.ctx.lists) throw new Error(`no list state for block ${i}`);
    return this.ctx.lists.snapshot();
  }

  /** Blocks before `i` won't be needed again. */
  release(i: number): void {
    for (const k of this.cache.keys()) {
      if (k < i) {
        this.cache.delete(k);
        this.listsBefore.delete(k);
      }
    }
  }
}

/** Thrown inside pagination when the new layout has caught up with the old one. */
class Converged {
  constructor(readonly oldIndex: number) {}
}

/** Thrown when a newer invalidate() supersedes a running layout. */
class Superseded {}

// --- Session -----------------------------------------------------------------------------

/**
 * A document's layout, kept up to date as the document changes. Create one per document;
 * call run() to lay it out, and invalidate() + run() after edits.
 */
export class LayoutSession {
  /** Pages of the last completed run. */
  pages: PageLayout[] = [];
  sections: SectionGeometry[] = [];
  timings = { fonts: 0, body: 0, headers: 0 };

  private readonly ctx: LayoutContext;
  private readonly measureCtx: LayoutContext;
  private readonly headerHeights = new Map<string, number>();
  private paragraphCache = new WeakMap<Paragraph, CachedParagraph>();
  /** First page each paragraph has lines on (valid while pages[page.index] === page). */
  private readonly pageOfParagraph = new WeakMap<Paragraph, PageLayout>();
  private readonly partsWithFields = new Set<string>();

  /** Changed paragraphs not yet laid out, and the page to restart from. */
  private dirty = new Set<Paragraph>();
  private restartAt = 0;
  /** Old pages can't be reused (styles or sections changed). */
  private noReuse = false;
  private generation = 0;
  /** A run in progress: its pages so far, for display while it continues. */
  private running: { from: number; pages: PageLayout[] } | null = null;

  private constructor(
    readonly doc: WordDocument,
    readonly fonts: FontSet,
    resolver: StyleResolver,
  ) {
    this.ctx = {
      doc,
      runStyles: runStyleCaches.get(doc) ?? runStyleCaches.set(doc, new Map()).get(doc),
      resolver,
      fonts,
      lists: new ListCounter(resolver),
      defaultTabStop: doc.settings.defaultTabStop / 20,
      paragraphCache: this.paragraphCache,
    };
    this.measureCtx = { ...this.ctx, lists: null, fields: { page: 1, pages: 1 } };
    for (const [part, hf] of doc.headersFooters) if (hasFields(hf.children)) this.partsWithFields.add(part);
  }

  static async create(doc: WordDocument, fonts: FontSet): Promise<LayoutSession> {
    const t0 = performance.now();
    const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
    await fonts.ensure(facesFor(doc, resolver, fonts));
    const cjk = cjkTextOf(doc, resolver, fonts);
    await Promise.all([...cjk].map(([lang, chars]) => fonts.ensureCjk(lang, chars)));
    if (hasMath(doc)) await fonts.ensureMath();
    const session = new LayoutSession(doc, fonts, resolver);
    for (const lang of cjk.keys()) session.cjkLangs.add(lang);
    session.timings.fonts = performance.now() - t0;
    return session;
  }

  /** Whether the pages are out of date (run() brings them up to date). */
  get needsLayout(): boolean {
    return this.restartAt !== Infinity;
  }

  /**
   * Pages to show now: while a run is in progress, its new pages followed by old pages
   * after them (a best guess until the run finishes).
   */
  get displayPages(): PageLayout[] {
    const r = this.running;
    if (!r) return this.pages;
    return [...this.pages.slice(0, r.from), ...r.pages, ...this.pages.slice(r.from + r.pages.length)];
  }

  /** The first page a paragraph has lines on, in displayPages order, if known. */
  pageOf(paragraph: Paragraph): PageLayout | undefined {
    const page = this.pageOfParagraph.get(paragraph);
    if (!page) return undefined;
    const shown = this.displayPages;
    return shown[page.index] === page ? page : shown.find((p) => p === page);
  }

  /**
   * A paragraph's lines in displayPages, with their pages, in order. Searches outward from
   * where the paragraph was last laid out (or `hint`, a page index) so it's cheap near there.
   */
  linesOf(paragraph: Paragraph, hint?: number): { page: PageLayout; line: LineRecord }[] {
    const shown = this.displayPages;
    if (shown.length === 0) return [];
    const known = this.pageOfParagraph.get(paragraph);
    const center = Math.min(Math.max(hint ?? known?.index ?? 0, 0), shown.length - 1);
    const has = (i: number) => shown[i].lines.some((l) => l.paragraph === paragraph);
    let found = -1;
    for (let d = 0; d < shown.length && found < 0; d++) {
      if (center - d >= 0 && has(center - d)) found = center - d;
      else if (center + d < shown.length && has(center + d)) found = center + d;
      if (center - d < 0 && center + d >= shown.length) break;
    }
    if (found < 0) return [];
    // Back to the first page with its lines, then forward through the last.
    let first = found;
    while (first > 0 && has(first - 1)) first--;
    const out: { page: PageLayout; line: LineRecord }[] = [];
    for (let i = first; i < shown.length; i++) {
      const lines = shown[i].lines.filter((l) => l.paragraph === paragraph);
      if (lines.length === 0 && i > found) break;
      for (const line of lines) out.push({ page: shown[i], line });
    }
    return out;
  }

  /**
   * Records that paragraphs changed: edited, inserted, or merged into. Include a paragraph
   * that was already laid out (the one an inserted paragraph was split from) so the session
   * knows where to restart. `structural` changes (sections, styles) re-lay out everything.
   */
  invalidate(paragraphs: Iterable<Paragraph>, options: { structural?: boolean } = {}): void {
    this.generation++;
    let restart = Infinity;
    if (options.structural) {
      restart = 0;
      this.noReuse = true;
    }
    for (const p of paragraphs) {
      this.dirty.add(p);
      this.paragraphCache.delete(p);
      const page = this.pageOfParagraph.get(p);
      if (page && this.pages[page.index] === page) restart = Math.min(restart, page.index);
    }
    // Nothing located (a paragraph never laid out): be safe.
    if (restart === Infinity) restart = 0;
    this.restartAt = Math.min(this.restartAt, restart);
  }

  /** The CJK languages the document's text is in, and the app's (see ensureCjk). */
  readonly cjkLangs = new Set<CjkLang>();

  /**
   * Loads the CJK pages that draw the given text (typed, pasted or replaced in), before the edit is
   * applied, for the languages of the document and the app's.
   */
  async ensureCjk(text: string): Promise<void> {
    const chars = new Set<number>();
    addCjk(text, chars);
    if (chars.size === 0) return;
    const langs = new Set<CjkLang>([...this.cjkLangs, this.fonts.defaultCjkLang]);
    await Promise.all([...langs].map((lang) => this.fonts.ensureCjk(lang, chars)));
  }

  /** Loads the math font, before an equation is added (typed, pasted or inserted). */
  async ensureMath(): Promise<void> {
    await this.fonts.ensureMath();
  }

  /** Loads the faces of fonts the document starts to use (a font picked for some text), before laying it out. */
  async ensureFonts(names: Iterable<string>): Promise<void> {
    const faces = new Set<ManifestFace>();
    for (const font of names) {
      for (const bold of [false, true]) for (const italic of [false, true]) faces.add(this.fonts.resolve({ font, bold, italic }).face);
    }
    await this.fonts.ensure(faces);
  }

  /** Call after changing styles, numbering or the theme. */
  invalidateStyles(): void {
    // The style sheet or numbering may be new objects: resolve against them from now on.
    const { doc } = this;
    const resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
    this.ctx.resolver = resolver;
    this.ctx.lists = new ListCounter(resolver);
    this.measureCtx.resolver = resolver;
    invalidateStyles(doc);
    this.ctx.runStyles = new Map();
    runStyleCaches.set(this.doc, this.ctx.runStyles);
    this.paragraphCache = new WeakMap();
    this.ctx.paragraphCache = this.paragraphCache;
    // The measuring context was copied from ctx: it must not keep the old caches either.
    this.measureCtx.runStyles = this.ctx.runStyles;
    this.measureCtx.paragraphCache = this.paragraphCache;
    // Header and footer heights depend on their styles.
    this.headerHeights.clear();
    this.invalidate([], { structural: true });
  }

  /**
   * Brings the pages up to date. Resolves with completed: false if an invalidate() during
   * one of its slices superseded it (call run() again).
   */
  async run(options: LayoutOptions = {}): Promise<RunResult> {
    if (!this.needsLayout) return { completed: true, from: this.pages.length, added: [], removed: [], moved: 0, convergedAt: -1 };
    const generation = this.generation;
    const t0 = performance.now();
    const result = await this.paginate(options, generation);
    if (!result.completed) return result;
    const t1 = performance.now();
    this.timings.body = t1 - t0;
    this.layoutOverlays(result, options);
    this.timings.headers = performance.now() - t1;
    return result;
  }

  // --- Pagination ------------------------------------------------------------------------

  private async paginate(options: LayoutOptions, generation: number): Promise<RunResult> {
    const { doc, ctx } = this;
    const { onPage, onSlice, signal } = options;
    const sliceMs = options.sliceMs ?? 8;
    signal?.throwIfAborted();

    const old = this.pages;
    const split = splitSections(doc);

    // Restart one page before the first change (keep-with-next and widow control can pull
    // content back onto it), at a page layout can resume from.
    const reuse = !this.noReuse;
    let from = 0;
    let resume: PageStart | undefined;
    if (reuse && this.restartAt > 0 && old.length > 0) {
      from = Math.min(this.restartAt - 1, old.length - 1);
      while (from > 0 && !old[from].start?.restartable) from--;
      resume = from > 0 ? old[from].start : undefined;
      if (!resume) from = 0;
    }

    // Changed top-level blocks (a table counts as changed if a paragraph in it did), and old
    // pages to compare against as layout catches up.
    const dirtyBlocks = new Set<Block>();
    if (this.dirty.size) {
      for (const s of split) {
        for (const block of s.blocks) {
          if (block.kind === 'paragraph' ? this.dirty.has(block) : tableHasAny(block, this.dirty)) dirtyBlocks.add(block);
        }
      }
    }
    const oldStarts = new Map<Block, number[]>();
    for (let i = from + 1; reuse && i < old.length; i++) {
      const start = old[i].start;
      if (!start?.restartable || !start.block) continue;
      let list = oldStarts.get(start.block);
      if (!list) oldStarts.set(start.block, (list = []));
      list.push(i);
    }
    const laterSectionParity = (s: number) =>
      split.slice(s + 1).some((x) => x.properties.type === 'oddPage' || x.properties.type === 'evenPage');

    const pages: PageLayout[] = [];
    this.running = { from, pages };
    // Sections are recomputed as layout reaches them; ones after where it converges are
    // unchanged (a change to sections is structural and never reuses old pages).
    if (!reuse) this.sections = [];
    const sections = this.sections;

    const partHeight = (part: string | undefined, width: number): number => {
      if (!part) return 0;
      const key = `${part}@${width}`;
      let h = this.headerHeights.get(key);
      if (h === undefined) {
        const hf = doc.headersFooters.get(part);
        h = hf ? layoutBox(hf.children, this.measureCtx, width).height : 0;
        this.headerHeights.set(key, h);
      }
      return h;
    };

    // Flow state.
    let page!: PageLayout;
    let section!: SectionGeometry;
    let sectionIndex = 0;
    let blocks!: LazyBlocks;
    let top = 0;
    let bottom = 0;
    let y = 0;
    let atTop = true;
    let naturalBreak = false;
    let pageNumber = 0;
    let firstOfSection = true;
    let previous: PreviousBlock | null = null;
    let pendingAfter = 0;
    let dirtyPlaced = 0;

    // Columns: the one being filled, where columns start on this page (a continuous section starts
    // part way down), and the lowest point any column reached (where the next section starts).
    let column = 0;
    let columnTop = 0;
    let lowest = 0;
    let columnsOpen = false;
    const columnLeft = () => section.left + column * (section.columnWidth + section.columnGap);
    /** Draws the lines between the columns of the section on the page just finished. */
    const closeColumns = () => {
      if (!columnsOpen) return;
      columnsOpen = false;
      if (!page || section.columns < 2 || !section.properties.columns?.sep) return;
      const bottomY = Math.max(lowest, y);
      if (bottomY <= columnTop) return;
      for (let k = 0; k < section.columns - 1; k++) {
        const x = section.left + (k + 1) * section.columnWidth + k * section.columnGap + section.columnGap / 2;
        page.foreground.push(x - 0.25, columnTop, 0.5, bottomY - columnTop, packColor(0));
      }
    };

    /** Where the next page resumes, as known by whoever breaks the page. */
    interface Resume {
      blockIndex: number;
      line?: number;
      row?: number;
      repeatHeaders?: boolean;
      restartable?: boolean;
      /** Flow state after the current block, when the page resumes at the next one. */
      previous?: PreviousBlock | null;
      pendingAfter?: number;
    }

    const bodyArea = (first: boolean, number: number) => {
      const header = partHeight(partFor(doc, section.headers, section, first, number), section.contentWidth);
      const footer = partHeight(partFor(doc, section.footers, section, first, number), section.contentWidth);
      // Negative margins fix the body position regardless of header/footer size.
      return {
        top: section.top < 0 ? -section.top : Math.max(section.top, section.header + header),
        bottom: section.height - (section.bottom < 0 ? -section.bottom : Math.max(section.bottom, section.footer + footer)),
      };
    };

    const openPage = (start: PageStart) => {
      page = new PageLayout(from + pages.length, section.width, section.height, sectionIndex, start.number);
      page.start = start;
      pages.push(page);
      top = start.top;
      bottom = start.bottom;
      y = top;
      atTop = true;
      naturalBreak = start.natural;
      firstOfSection = false;
      column = 0;
      columnTop = top;
      lowest = top;
      columnsOpen = true;
    };

    /**
     * Continues at the top of the next column, or, after the last (or with `forcePage`, for a page
     * break or the start of a section), on a new page.
     */
    const newPage = (natural: boolean, at: Resume, forcePage = false) => {
      if (!forcePage && column < section.columns - 1) {
        lowest = Math.max(lowest, y);
        column++;
        y = columnTop;
        atTop = true;
        naturalBreak = natural;
        return;
      }
      closeColumns();
      pageNumber++;
      const area = bodyArea(firstOfSection, pageNumber);
      const block = blocks.block(at.blockIndex);
      const start: PageStart = {
        section: sectionIndex,
        blockIndex: at.blockIndex,
        block,
        line: at.line ?? 0,
        row: at.row ?? 0,
        repeatHeaders: at.repeatHeaders ?? false,
        restartable: (at.restartable ?? true) && block !== null,
        natural,
        pendingAfter: at.pendingAfter ?? pendingAfter,
        previous: at.previous !== undefined ? at.previous : previous,
        lists: blocks.listsAt(at.blockIndex),
        number: pageNumber,
        firstOfSection,
        top: area.top,
        bottom: area.bottom,
      };
      if (start.restartable && block && dirtyPlaced === dirtyBlocks.size && !dirtyBlocks.has(block)) {
        const match = oldStarts.get(block)?.find((i) => sameStart(start, old[i].start!, doc, laterSectionParity(sectionIndex)));
        if (match !== undefined) throw new Converged(match);
      }
      openPage(start);
    };

    const placeFloats = (floats: FloatSpec[], paragraphTop: number) => {
      for (const f of floats) {
        if (!f.drawing.image && !f.drawing.textBox) continue;
        const w = f.drawing.width / 12700;
        const h = f.drawing.height / 12700;
        const frameX =
          f.h.relativeFrom === 'page' ? [0, section.width]
          : f.h.relativeFrom === 'leftMargin' ? [0, section.left]
          : f.h.relativeFrom === 'rightMargin' ? [section.width - section.right, section.right]
          : [section.left, section.contentWidth];
        const frameY =
          f.v.relativeFrom === 'page' ? [0, section.height]
          : f.v.relativeFrom === 'margin' ? [top, bottom - top]
          : f.v.relativeFrom === 'topMargin' ? [0, section.top]
          : f.v.relativeFrom === 'bottomMargin' ? [section.height - section.bottom, section.bottom]
          : [paragraphTop, 0];
        const place = (frame: number[], size: number, spec: FloatSpec['h']) =>
          spec.offset !== undefined ? frame[0] + spec.offset
          : spec.align === 'center' ? frame[0] + (frame[1] - size) / 2
          : spec.align === 'right' || spec.align === 'bottom' || spec.align === 'outside' ? frame[0] + frame[1] - size
          : frame[0];
        const x = place(frameX, w, f.h);
        const y = place(frameY, h, f.v);
        if (f.drawing.image) page.images.push({ part: f.drawing.image, x, y, width: w, height: h, behind: f.behind });
        else {
          // A text box: its paragraphs laid out like a cell's, at the box's place. Its lines aren't
          // recorded (a click or a caret doesn't get into it: it can't be edited in place yet).
          const inset = f.inset;
          const content = layoutBox(f.drawing.textBox!, ctx, Math.max(w - inset.left - inset.right, 1));
          const recorded = page.lines.length;
          emitBox(page, content, x + inset.left, y + inset.top);
          page.lines.length = recorded;
        }
      }
    };

    /**
     * Height needed to honor "keep with next" from block i: the chain of keep-with-next
     * paragraphs plus the first line (or row) of the block after it.
     */
    const keepChainHeight = (i: number): number => {
      let height = 0;
      for (let k = i; k < blocks.length; k++) {
        const b = blocks.get(k);
        if (!('lines' in b)) return height + (b.rows[0]?.height ?? 0);
        if (k > i) height += b.spaceBefore;
        if (!b.keepNext || k === blocks.length - 1) return height + (k === i ? b.height : (b.lines[0]?.height ?? 0));
        height += b.height + b.spaceAfter;
      }
      return height;
    };

    const info = (p: ParagraphLayout): PreviousBlock => ({ styleId: p.styleId, contextualSpacing: p.contextualSpacing, keepNext: p.keepNext });

    const placeParagraph = (p: ParagraphLayout, spaceAbove: number, index: number, fromLine: number) => {
      const lines = p.lines;
      let i = fromLine;
      if (fromLine === 0) {
        if (p.pageBreakBefore && !atTop) newPage(false, { blockIndex: index }, true);
        const suppress = atTop && naturalBreak;
        y += suppress ? 0 : spaceAbove;
        const room = bottom - y;
        const pageRoom = bottom - columnTop;
        // Keep with next: a chain of keep-with-next paragraphs that doesn't fit starts on a new
        // page (checked where the chain starts; one longer than a page then breaks normally).
        // Keep lines together: a paragraph that doesn't fit but would fit a page moves as a whole.
        if (!atTop) {
          const chainStart = !previous?.keepNext;
          if (p.keepNext && chainStart && index + 1 < blocks.length && keepChainHeight(index) > room) newPage(true, { blockIndex: index });
          if (!atTop && p.keepLines && p.height > bottom - y && p.height <= pageRoom) newPage(true, { blockIndex: index });
        }
      }
      let floatsPlaced = fromLine > 0;
      while (i < lines.length) {
        const room = bottom - y;
        // How many lines fit on this page.
        let fit = 0;
        let h = 0;
        while (i + fit < lines.length) {
          const line = lines[i + fit];
          if (h + line.height > room + 0.01 && !(atTop && fit === 0)) break;
          h += line.height;
          fit++;
          if (line.pageBreak) break;
        }
        const endsWithBreak = fit > 0 && lines[i + fit - 1].pageBreak;
        // A column break goes on to the next column; a page break always starts a page.
        const forcePage = endsWithBreak && !lines[i + fit - 1].columnBreak;
        if (i + fit < lines.length && !endsWithBreak && p.widowControl && lines.length > 1) {
          // Orphan: don't leave a paragraph's first line alone at the bottom of a page.
          if (i === 0 && fit === 1 && !atTop) fit = 0;
          // Widow: don't leave its last line alone at the top of the next page.
          else if (lines.length - (i + fit) === 1 && fit >= 2) fit--;
        }
        for (let k = 0; k < fit; k++) {
          const line = lines[i + k];
          if (!floatsPlaced && p.floats.length) {
            placeFloats(p.floats, y);
            floatsPlaced = true;
          }
          emitLine(page, p, line, columnLeft(), y, section.columns > 1 ? section.columnWidth : undefined);
          y += line.height;
          atTop = false;
        }
        i += fit;
        if (i < lines.length) newPage(!endsWithBreak, { blockIndex: index, line: i }, forcePage);
        else if (endsWithBreak) newPage(false, { blockIndex: index + 1, previous: info(p), pendingAfter: p.spaceAfter }, forcePage);
      }
    };

    const placeTable = (table: TableLayout, index: number, fromRow: number, repeatHeaders: boolean) => {
      const headerRows: number[] = [];
      for (let r = 0; r < table.rows.length && table.rows[r].header; r++) headerRows.push(r);
      const emitHeaders = () => {
        for (const hr of headerRows) {
          emitRow(page, table, hr, columnLeft(), y);
          y += table.rows[hr].height;
        }
      };
      const continuePage = (r: number, restartable = true) => {
        newPage(true, { blockIndex: index, row: r, repeatHeaders: r >= headerRows.length, restartable });
        if (r >= headerRows.length) emitHeaders();
      };
      if (repeatHeaders) emitHeaders();

      for (let r = fromRow; r < table.rows.length; r++) {
        const row = table.rows[r];
        if (y + row.height <= bottom + 0.01) {
          emitRow(page, table, r, columnLeft(), y);
          y += row.height;
          atTop = false;
          continue;
        }
        // Rows that can't break move to the next page whole (and overflow if taller than a page).
        const splittable = !row.cantSplit && !row.header && row.cells.every((c) => c.rowSpan <= 1);
        if (!splittable) {
          if (!atTop) continuePage(r);
          emitRow(page, table, r, columnLeft(), y);
          y += row.height;
          atTop = false;
          continue;
        }
        // Split the row at line boundaries in each cell, continuing on following pages.
        let cut = row.cells.map(() => 0);
        const remaining = () => Math.max(...row.cells.map((c, i) => c.content.height - cut[i] + c.marginTop + c.marginBottom));
        if (remaining() <= bottom - y + 0.01 || (atTop && remaining() > row.height)) {
          // The content fits; only a specified row height doesn't. Move the row whole.
          if (!atTop) continuePage(r);
          emitRow(page, table, r, columnLeft(), y);
          y += row.height;
          atTop = false;
          continue;
        }
        for (let guard = 0; guard < 100_000; guard++) {
          const rest = remaining();
          if (rest <= bottom - y + 0.01) {
            emitRowSlice(page, table, r, columnLeft(), y, { from: cut, to: row.cells.map(() => Infinity), height: rest });
            y += rest;
            atTop = false;
            break;
          }
          let to = row.cells.map((c, i) => cutBox(c.content, cut[i], bottom - y - c.marginTop - c.marginBottom));
          if (!to.some((t, i) => t > cut[i] + 0.01)) {
            if (!atTop) {
              // Resuming here would place the row whole rather than as a slice: not a restart point.
              continuePage(r, false);
              continue;
            }
            // Nothing fits even on an empty page: take one item from each cell to make progress.
            to = row.cells.map((c, i) => nextItemEnd(c.content, cut[i]));
          }
          emitRowSlice(page, table, r, columnLeft(), y, { from: cut, to, height: bottom - y });
          cut = to;
          continuePage(r, false);
        }
      }
    };

    // Streaming: pages before the current one are final.
    let delivered = 0;
    const deliver = (all: boolean) => {
      const upTo = all ? pages.length : pages.length - 1;
      while (delivered < upTo) {
        const page = pages[delivered++];
        onPage?.(page);
      }
    };
    let sliceStart = performance.now();
    const slice = async () => {
      deliver(false);
      await onSlice?.();
      signal?.throwIfAborted();
      if (this.generation !== generation) throw new Superseded();
      sliceStart = performance.now();
    };

    let convergedAt = -1;
    try {
      const firstSection = resume ? resume.section : 0;
      for (let s = firstSection; s < split.length; s++) {
        const sb = split[s];
        sectionIndex = s;
        let firstBlock = 0;
        let fromLine = 0;
        let fromRow = 0;
        let repeat = false;
        if (resume && s === firstSection) {
          section = sections[s];
          // Found by identity: edits before this page since it was laid out shift indices.
          firstBlock = sb.blocks.indexOf(resume.block!);
          if (firstBlock < 0) throw new Error('restart block is no longer in its section');
          fromLine = resume.line;
          fromRow = resume.row;
          repeat = resume.repeatHeaders;
          pageNumber = resume.number;
          firstOfSection = resume.firstOfSection;
          previous = resume.previous;
          pendingAfter = resume.pendingAfter;
          ctx.lists!.restore(resume.lists);
          blocks = new LazyBlocks(sb.blocks, ctx, section.columnWidth, firstBlock);
          openPage(resume);
        } else {
          closeColumns();
          section = geometry(sb.properties, sections[s - 1]);
          sections[s] = section;
          firstOfSection = true;
          previous = null;
          pendingAfter = 0;
          if (s === 0) {
            pageNumber = 0;
            ctx.lists!.restore(new Map());
          }
          if (sb.properties.pageNumbering?.start !== undefined) pageNumber = sb.properties.pageNumbering.start - 1;
          blocks = new LazyBlocks(sb.blocks, ctx, section.columnWidth, 0);
          const type = sb.properties.type ?? 'nextPage';
          const prevSection = sections[s - 1];
          const samePageSize = prevSection && prevSection.width === section.width && prevSection.height === section.height;
          if (s === 0 || type !== 'continuous' || !samePageSize || pages.length === 0) {
            // Odd/even section starts may need a blank page first.
            const blank = (type === 'oddPage' && pageNumber % 2 === 1) || (type === 'evenPage' && pageNumber % 2 === 0);
            if (blank) newPage(false, { blockIndex: 0, restartable: false }, true);
            newPage(false, { blockIndex: 0 }, true);
          } else {
            // A continuous section carries on below the lowest column of the one before.
            column = 0;
            y = Math.max(y, lowest);
            columnTop = y;
            lowest = y;
            columnsOpen = true;
          }
        }

        for (let i = firstBlock; i < blocks.length; i++) {
          const block = blocks.get(i);
          if (dirtyBlocks.has(blocks.block(i)!)) dirtyPlaced++;
          const resuming = i === firstBlock && (fromLine > 0 || fromRow > 0 || repeat);
          if ('lines' in block) {
            if (resuming) placeParagraph(block, 0, i, fromLine);
            else {
              const sameStyle = previous && previous.styleId === block.styleId;
              const after = sameStyle && previous!.contextualSpacing ? 0 : pendingAfter;
              const before = sameStyle && block.contextualSpacing ? 0 : block.spaceBefore;
              placeParagraph(block, after + before, i, 0);
            }
            pendingAfter = block.spaceAfter;
            previous = info(block);
          } else {
            if (!resuming) {
              y += atTop ? 0 : pendingAfter;
              pendingAfter = 0;
            }
            placeTable(block, i, resuming ? fromRow : 0, resuming && repeat);
            previous = null;
            pendingAfter = 0;
          }
          blocks.release(i);
          if (onSlice && performance.now() - sliceStart >= sliceMs) await slice();
        }
      }
      closeColumns();
    } catch (e) {
      if (e instanceof Converged) convergedAt = e.oldIndex;
      else {
        this.running = null;
        if (e instanceof Superseded) return { completed: false, from, added: [], removed: [], moved: 0, convergedAt: -1 };
        throw e;
      }
    }
    deliver(true);
    this.running = null;

    // Commit: pages before `from`, the new pages, then old pages from where layout converged.
    const tail = convergedAt >= 0 ? old.slice(convergedAt) : [];
    const removed = old.slice(from, convergedAt >= 0 ? convergedAt : old.length);
    this.pages = [...old.slice(0, from), ...pages, ...tail];
    if (tail.length) {
      const shift = this.pages.length - old.length;
      const numberShift = pages.length ? pages[pages.length - 1].number + 1 - tail[0].number : 0;
      let renumber = numberShift !== 0;
      for (const p of tail) {
        p.index += shift;
        // Page numbers shift until a section restarts numbering.
        if (renumber && p.start!.firstOfSection && sections[p.section]?.properties.pageNumbering?.start !== undefined) renumber = false;
        if (renumber) {
          p.number += numberShift;
          p.start!.number += numberShift;
        }
      }
      // Sections after the one layout stopped in are unchanged.
    }
    // First page of each paragraph on the new pages (entries for removed pages are replaced).
    for (const p of pages) {
      for (const line of p.lines) {
        const known = this.pageOfParagraph.get(line.paragraph);
        if (!known || this.pages[known.index] !== known || known.index > p.index) this.pageOfParagraph.set(line.paragraph, p);
      }
    }
    this.dirty.clear();
    this.restartAt = Infinity;
    this.noReuse = false;
    return {
      completed: true,
      from,
      added: pages,
      removed,
      moved: tail.length && this.pages.length !== old.length ? tail.length : 0,
      convergedAt,
    };
  }

  // --- Headers and footers ---------------------------------------------------------------

  /**
   * Headers and footers, once page numbers and the page count are known: for new pages, and
   * for kept pages whose page number or page count their fields show has changed.
   */
  private layoutOverlays(result: RunResult, options: LayoutOptions): void {
    const { doc, ctx } = this;
    const added = new Set(result.added);
    const countChanged = result.removed.length !== result.added.length;
    const numbersMoved = result.moved > 0 || countChanged;
    for (const p of this.pages) {
      const s = this.sections[p.section];
      const first = p.start?.firstOfSection ?? false;
      const headerPart = partFor(doc, s.headers, s, first, p.number);
      const footerPart = partFor(doc, s.footers, s, first, p.number);
      if (!added.has(p)) {
        const usesFields = (headerPart && this.partsWithFields.has(headerPart)) || (footerPart && this.partsWithFields.has(footerPart));
        if (!usesFields || !numbersMoved) continue;
      }
      const fields: FieldValues = { page: p.number, pages: this.pages.length, format: s.properties.pageNumbering?.fmt };
      const hfCtx: LayoutContext = { ...ctx, lists: null, fields };
      const box = (part: string | undefined): BoxLayout | undefined => {
        const hf = part ? doc.headersFooters.get(part) : undefined;
        return hf ? layoutBox(hf.children, hfCtx, s.contentWidth) : undefined;
      };
      const h = box(headerPart);
      const f = box(footerPart);
      if (!h && !f) continue;
      const overlay = new PageLayout(p.index, p.width, p.height, p.section, p.number);
      if (h) emitBox(overlay, h, s.left, s.header);
      if (f) emitBox(overlay, f, s.left, s.height - s.footer - f.height);
      options.onHeaderFooter?.(p, overlay);
      if (options.mergeOverlays ?? true) p.append(overlay);
    }
  }
}

/** Which header/footer applies to a page. */
function partFor(
  doc: WordDocument,
  refs: SectionGeometry['headers'],
  section: SectionGeometry,
  firstOfSection: boolean,
  number: number,
): string | undefined {
  if (firstOfSection && section.properties.titlePage) return refs.first;
  if (doc.settings.evenAndOddHeaders && number % 2 === 0) return refs.even;
  return refs.default;
}

function tableHasAny(table: Table, paragraphs: Set<Paragraph>): boolean {
  for (const block of flattenTable(table)) if (paragraphs.has(block)) return true;
  return false;
}

function flattenTable(table: Table): Paragraph[] {
  const out: Paragraph[] = [];
  for (const row of table.rows) {
    if (row.kind !== 'row') continue;
    for (const cell of row.cells) {
      if (cell.kind !== 'cell') continue;
      for (const b of flattenBlocks(cell.children)) {
        if (b.kind === 'paragraph') out.push(b);
        else out.push(...flattenTable(b));
      }
    }
  }
  return out;
}

/**
 * Whether layout from two page starts produces the same pages (so old pages from here on can
 * be kept). Page numbers may differ as long as nothing downstream depends on their parity.
 */
function sameStart(a: PageStart, b: PageStart, doc: WordDocument, laterParity: boolean): boolean {
  if (
    a.section !== b.section ||
    a.block !== b.block ||
    a.line !== b.line ||
    a.row !== b.row ||
    a.repeatHeaders !== b.repeatHeaders ||
    a.natural !== b.natural ||
    a.firstOfSection !== b.firstOfSection ||
    Math.abs(a.pendingAfter - b.pendingAfter) > 1e-6 ||
    Math.abs(a.top - b.top) > 1e-6 ||
    Math.abs(a.bottom - b.bottom) > 1e-6 ||
    !samePrevious(a.previous, b.previous) ||
    !ListCounter.sameState(a.lists, b.lists)
  ) {
    return false;
  }
  const shift = a.number - b.number;
  if (shift % 2 !== 0 && (doc.settings.evenAndOddHeaders || laterParity)) return false;
  return true;
}

function samePrevious(a: PreviousBlock | null, b: PreviousBlock | null): boolean {
  if (!a || !b) return a === b;
  return a.styleId === b.styleId && a.contextualSpacing === b.contextualSpacing && a.keepNext === b.keepNext;
}

/**
 * Resolved run styles per document, reused across sessions. Cleared by invalidateStyles.
 */
const runStyleCaches = new WeakMap<WordDocument, Map<string, RunStyle>>();

/** Call after editing a document's styles, numbering or theme. */
export function invalidateStyles(doc: WordDocument): void {
  runStyleCaches.delete(doc);
  clearTableStyles(doc);
}

/** Lays out a whole document once (see LayoutSession to keep a layout up to date). */
export async function layoutDocument(doc: WordDocument, fonts: FontSet, options: LayoutOptions = {}): Promise<DocumentLayout> {
  options.signal?.throwIfAborted();
  const session = await LayoutSession.create(doc, fonts);
  const result = await session.run(options);
  if (!result.completed) throw new Error('layout superseded');
  return { pages: session.pages, sections: session.sections, timings: session.timings };
}
