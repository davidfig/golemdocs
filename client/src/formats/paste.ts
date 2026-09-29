// Pasting formatted text: what came from the clipboard as HTML, made ready to go in a document.
//
// The clipboard's HTML is read with the same importer that opens .html files, into a scratch
// document. Its paragraphs and tables are what gets pasted; what they need from that document to
// look as they did (the styles they use, their list definitions) is carried over as operations.

import { paragraphsIn, type Block, type Inline, type Style, type WordDocument } from '@word/docx';
import type { Operation } from '@word/ops';
import { importDocument } from './convert.ts';
import { styleFor } from './markdownStyles.ts';
import { linkAddress } from '../ui/linkDialog.ts';

export interface Pasted {
  blocks: Block[];
  /** Styles and list definitions the blocks use that the target document lacks. */
  define: Operation[];
  /** Fonts the text asks for by name, to load before it is shown. */
  fonts: Set<string>;
}

const encoder = new TextEncoder();

/** Whether a block holds nothing at all (an empty paragraph). */
const isEmpty = (b: Block): boolean => b.kind === 'paragraph' && b.children.length === 0;

/** Every run and link of some inlines, in order. */
function* inlinesOf(inlines: readonly Inline[]): Generator<Inline> {
  for (const inline of inlines) {
    yield inline;
    if (inline.kind === 'hyperlink' || inline.kind === 'wrapper') yield* inlinesOf(inline.children);
  }
}

/** Links whose address the app wouldn't open (javascript:…) lose the link and keep their text. */
function unwrapUnsafeLinks(inlines: Inline[]): Inline[] {
  return inlines.flatMap((inline): Inline[] => {
    if (inline.kind === 'hyperlink') {
      const children = unwrapUnsafeLinks(inline.children);
      return inline.url && linkAddress(inline.url) ? [{ ...inline, children }] : children;
    }
    if (inline.kind === 'wrapper') return [{ ...inline, children: unwrapUnsafeLinks(inline.children) }];
    return [inline];
  });
}

/**
 * The clipboard's HTML as blocks to paste into `target`, or null if it holds nothing to paste.
 * Throws if it can't be read at all (the caller pastes the plain text instead).
 */
export async function htmlToPaste(html: string, target: WordDocument): Promise<Pasted | null> {
  const { document } = await importDocument('html', encoder.encode(html));
  // Blocks as they are: no section breaks, no unmodeled content, and no empty lines at the ends.
  let blocks: Block[] = structuredClone(document.body).flatMap((b): Block[] => (b.kind === 'wrapper' ? b.children : b.kind === 'raw' ? [] : [b]));
  while (blocks.length && isEmpty(blocks[0])) blocks.shift();
  while (blocks.length && isEmpty(blocks[blocks.length - 1])) blocks.pop();
  if (blocks.length === 0) return null;

  const paragraphs = paragraphsIn(blocks);
  for (const p of paragraphs) {
    delete p.properties.section;
    delete p.attrs['w14:paraId'];
    p.children = unwrapUnsafeLinks(p.children);
  }

  // Styles the blocks use: paragraphs, runs and tables, and what those are based on.
  const wanted = new Set<string>();
  for (const p of paragraphs) {
    if (p.properties.style) wanted.add(p.properties.style);
    for (const inline of inlinesOf(p.children)) if (inline.kind === 'run' && inline.properties.style) wanted.add(inline.properties.style);
  }
  for (const b of blocks) if (b.kind === 'table' && b.properties.style) wanted.add(b.properties.style);
  const known = new Set(target.styles.styles.map((s) => s.id));
  const define: Operation[] = [];
  const add = (id: string): void => {
    if (known.has(id)) return;
    // The scratch document's own definition, else the app's built-in one (headings, quotes, code, lists, links).
    const style: Style | undefined = document.styles.styles.find((s) => s.id === id) ?? styleFor(id);
    if (!style) return;
    known.add(id);
    // What it is based on first, so the target never has a style pointing at nothing.
    if (style.basedOn) add(style.basedOn);
    define.push({ type: 'setStyle', id, style: structuredClone(style) });
  };
  for (const id of wanted) add(id);

  // Lists: each numbering instance used gets one of its own in the target, under new ids.
  const numbering = target.numbering;
  let nextInstance = Math.max(0, ...numbering.instances.map((i) => i.id)) + 1;
  let nextAbstract = Math.max(0, ...numbering.abstracts.map((a) => a.id)) + 1;
  const instanceOf = new Map<number, number>();
  for (const p of paragraphs) {
    const list = p.properties.numbering;
    if (!list?.id) continue;
    let mapped = instanceOf.get(list.id);
    if (mapped === undefined) {
      const instance = document.numbering.instances.find((i) => i.id === list.id);
      const abstract = instance && document.numbering.abstracts.find((a) => a.id === instance.abstractId);
      if (instance && abstract) {
        mapped = nextInstance++;
        const abstractId = nextAbstract++;
        define.push({ type: 'setList', id: mapped, list: { instance: { ...structuredClone(instance), id: mapped, abstractId }, abstract: { ...structuredClone(abstract), id: abstractId } } });
        instanceOf.set(list.id, mapped);
      }
    }
    if (mapped === undefined) delete p.properties.numbering;
    else p.properties.numbering = { ...list, id: mapped };
  }

  const fonts = new Set<string>();
  for (const p of paragraphs) {
    for (const inline of inlinesOf(p.children)) {
      if (inline.kind !== 'run') continue;
      const names = inline.properties.fonts;
      for (const name of [names?.ascii, names?.hAnsi]) if (name) fonts.add(name);
    }
  }
  return { blocks, define, fonts };
}
