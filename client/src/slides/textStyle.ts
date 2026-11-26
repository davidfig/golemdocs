// The text of a slide's shape with its styles worked out (docs/slides.md): each paragraph's level settings come, lowest
// first, from the master's text style for its kind of placeholder (`p:titleStyle`, `p:bodyStyle`, `p:otherStyle`; the
// presentation's `p:defaultTextStyle` for any other shape), the master's and layout's placeholder list styles, the shape's
// own list style, then the paragraph's own properties. The reading itself is DrawingML's (drawingml/text.ts).

import type { XmlElement } from '@golemdocs/docx';
import type { Deck, DeckPart, SlidePart } from './deck.ts';
import { at, kid, kids } from './ooxml.ts';
import { styleRef, type ResolvedShape } from './shapes.ts';
import { bodySettings, readBody, type Paragraph, type TextBody, type TextContext as DrawingTextContext } from '../drawingml/text.ts';

export * from '../drawingml/text.ts';

/** Which master text style a placeholder kind uses. */
export function masterStyleFor(type: string | undefined): 'p:titleStyle' | 'p:bodyStyle' | 'p:otherStyle' | null {
  if (type === undefined) return null;
  if (type === 'title' || type === 'ctrTitle') return 'p:titleStyle';
  if (type === 'body' || type === 'subTitle' || type === 'obj') return 'p:bodyStyle';
  return 'p:otherStyle';
}

/** The text style sources of a shape, lowest first, each a list style (`a:lstStyle` or a master text style). */
export function styleSources(shape: ResolvedShape, deck: Deck, base?: XmlElement): (XmlElement | undefined)[] {
  const sources: (XmlElement | undefined)[] = [];
  const type = shape.placeholder?.type;
  const master = masterOf(shape.part);
  if (base) sources.push(base);
  else if (type === undefined || !master) sources.push(kid(deck.presentation.xml, 'p:defaultTextStyle'));
  else sources.push(at(master.xml, `p:txStyles/${masterStyleFor(type)}`));
  for (const from of [...shape.inherits].reverse()) sources.push(at(from, 'p:txBody/a:lstStyle'));
  sources.push(at(shape.element, 'p:txBody/a:lstStyle'));
  return sources;
}

function masterOf(part: DeckPart): import('./deck.ts').MasterPart | null {
  const slide = part as SlidePart;
  if (slide.layout) return slide.layout.master;
  const layout = part as import('./deck.ts').LayoutPart;
  if (layout.master) return layout.master;
  return (part as import('./deck.ts').MasterPart).theme ? (part as import('./deck.ts').MasterPart) : null;
}

export interface TextContext extends DrawingTextContext {
  deck: Deck;
  /** The slide's number, for slide number fields. */
  slideNumber: number;
  /** Today, for date fields. */
  date: Date;
  /** The part whose relationships hyperlinks are in. */
  part: DeckPart;
}

/** A slide's text context: hyperlinks are the part's relationships, and fields show the slide's number and today. */
export function slideTextContext(deck: Deck, part: DeckPart, ctx: TextContext['ctx'], slideNumber: number, date: Date): TextContext {
  return {
    deck,
    ctx,
    slideNumber,
    date,
    part,
    link: (rId) => part.rels.byId(rId)?.target ?? null,
    field: (type, saved) => (type === 'slidenum' ? String(slideNumber) : type?.startsWith('datetime') ? date.toLocaleDateString() : saved),
  };
}

/** The text body of a shape with everything resolved (empty when it has no text). */
export function shapeText(shape: ResolvedShape, tc: TextContext): TextBody {
  const txBody = kid(shape.element, 'p:txBody');
  const settings = bodySettings(shape);
  const fontRef = shape.placeholder ? undefined : styleRef(shape, 'a:fontRef');
  const paragraphs = readBody(txBody, styleSources(shape, tc.deck), settings, tc, fontRef);
  return { settings, paragraphs, element: txBody ?? null };
}

/** The prompt a placeholder shows while it is empty (its layout's text), for the editor. */
export function promptText(shape: ResolvedShape, tc: TextContext): Paragraph[] | null {
  if (!shape.placeholder) return null;
  for (const from of shape.inherits) {
    const txBody = kid(from, 'p:txBody');
    if (!txBody || !kids(txBody, 'a:p').some((p) => kids(p, 'a:r').length)) continue;
    const settings = bodySettings(shape);
    // The prompt is read as if it were the shape's own text, with the shape's styles.
    return readBody(txBody, styleSources(shape, tc.deck), settings, tc);
  }
  return null;
}

