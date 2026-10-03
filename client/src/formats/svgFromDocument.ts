// A document as vector graphics: lays it out and draws its pages, one under the other, as an SVG
// scene. Text stays text (a `text` element per run of letters, each letter at its laid-out
// position, so wrapping and page breaks match the editor and the words can still be edited);
// rectangles (backgrounds, borders, table lines) are rectangles; pictures are embedded; equations
// are the outlines of their glyphs.

import type { WordDocument } from '@golemdocs/docx';
import { TrueTypeFont } from '@golemdocs/pdf';
import { layoutDocument, type FontSet, type GlyphList, type PageLayout } from '@golemdocs/layout';
import type { GroupNode, PathNode, Scene, SceneNode, Style, TextNode } from '../vector/model.ts';
import { emptyScene } from '../vector/model.ts';
import { parsePath } from '../vector/pathData.ts';
import { fmt } from '../vector/matrix.ts';
import { writeSvg } from '../vector/svgWrite.ts';
import { sniffImage, MIME } from './images.ts';
import { standardFamily } from './standardFonts.ts';

const GENERIC = { Times: 'serif', Helvetica: 'sans-serif', Courier: 'monospace' } as const;
/** CSS pixels per point: a page is drawn at its size on paper. */
const PX_PER_PT = 96 / 72;

/** Layout's packed little-endian RGBA8 as a fill and its opacity. */
function paint(packed: number): Style {
  const r = packed & 0xff;
  const g = (packed >> 8) & 0xff;
  const b = (packed >> 16) & 0xff;
  const a = (packed >>> 24) / 255;
  return { fill: `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`, ...(a < 1 && { 'fill-opacity': fmt(a) }) };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Text glyphs of one face, as runs: consecutive glyphs on a baseline with one size and colour, with a space where there is a gap. */
function textRuns(list: GlyphList, nodes: SceneNode[]): void {
  const { font, metrics } = list;
  const generic = GENERIC[standardFamily(font)];
  const family = `'${font.family.wordName}', '${font.family.substitute}', ${generic}`;
  const bold = font.face.weight >= 600 || font.syntheticBold;
  const italic = font.face.italic || font.syntheticItalic;
  let text = '';
  const xs: number[] = [];
  let first: { y: number; size: number; color: number } | null = null;
  let end = 0;
  const flush = (): void => {
    if (first && text.trim()) {
      const style: Style = { ...paint(first.color), 'font-family': family, 'font-size': fmt(first.size) };
      if (bold) style['font-weight'] = 'bold';
      if (italic) style['font-style'] = 'italic';
      const node: TextNode = { kind: 'text', x: xs[0], y: first.y, runs: [{ text, style: {} }], style, attrs: xs.length > 1 ? { x: xs.map(fmt).join(' ') } : {} };
      nodes.push(node);
    }
    text = '';
    xs.length = 0;
    first = null;
  };
  for (let i = 0; i < list.count; i++) {
    const code = metrics.layout.glyphs[list.glyph(i)]?.unicode;
    if (code === undefined) continue;
    const x = list.x(i);
    const y = list.y(i);
    const size = list.size(i);
    const color = list.color(i);
    if (first && (Math.abs(first.y - y) > 0.01 || first.size !== size || first.color !== color || x < end - size * 0.5)) flush();
    // Spaces are not glyphs in layout: a gap between letters is written as a real space.
    if (first && x - end > 0.1 * size) {
      text += ' ';
      xs.push(end);
    }
    first ??= { y, size, color };
    text += String.fromCodePoint(code);
    // An astral character is two UTF-16 units but one position.
    xs.push(x);
    end = x + metrics.advance(list.glyph(i)) * size;
  }
  flush();
}

/** The scene for a document's laid-out pages. */
export async function documentToScene(doc: WordDocument, fonts: FontSet): Promise<Scene> {
  const layout = await layoutDocument(doc, fonts);
  const pages: PageLayout[] = layout.pages;
  let mathFont: TrueTypeFont | undefined | null = null;
  const math = async (): Promise<TrueTypeFont | undefined> => {
    if (mathFont === null) {
      const file = fonts.mathFace?.font ? await fonts.fontFile(fonts.mathFace.font) : undefined;
      mathFont = file ? TrueTypeFont.parse(file) : undefined;
    }
    return mathFont;
  };
  const widthPt = Math.max(1, ...pages.map((p) => p.width));
  const heightPt = Math.max(1, pages.reduce((sum, p) => sum + p.height, 0));
  const scene = emptyScene(widthPt * PX_PER_PT, heightPt * PX_PER_PT);
  scene.viewBox = { x: 0, y: 0, width: widthPt, height: heightPt };
  const media = new Map<string, string | null>();
  const hrefFor = async (part: string): Promise<string | null> => {
    if (!media.has(part)) {
      const bytes = await doc.media(part).catch(() => null);
      const image = bytes ? sniffImage(bytes) : null;
      media.set(part, bytes && image ? `data:${MIME[image.type]};base64,${base64(bytes)}` : null);
    }
    return media.get(part)!;
  };

  let top = 0;
  let number = 0;
  for (const page of pages) {
    number++;
    const children: SceneNode[] = [{ kind: 'rect', x: 0, y: 0, width: page.width, height: page.height, rx: 0, ry: 0, style: { fill: '#ffffff' }, attrs: {} }];
    const rects = (list: PageLayout['background']): void => {
      for (let i = 0; i < list.count; i++) {
        const [x, y, width, height] = list.rect(i);
        children.push({ kind: 'rect', x, y, width, height, rx: 0, ry: 0, style: paint(list.color(i)), attrs: {} });
      }
    };
    const images = async (behind: boolean): Promise<void> => {
      for (const item of page.images) {
        if (item.behind !== behind) continue;
        const href = await hrefFor(item.part);
        if (href) children.push({ kind: 'image', x: item.x, y: item.y, width: item.width, height: item.height, href, style: {}, attrs: {} });
      }
    };
    rects(page.background);
    await images(true);
    for (const list of page.glyphs.values() as Iterable<GlyphList>) {
      if (list.font.family.math) {
        const program = await math();
        if (!program) continue;
        for (let i = 0; i < list.count; i++) {
          const commands = parsePath(program.glyphPath(list.metrics.layout.glyphs[list.glyph(i)]?.index ?? list.glyph(i)));
          if (!commands.length) continue;
          const s = list.size(i) / program.unitsPerEm;
          const node: PathNode = { kind: 'path', commands, transform: [s, 0, 0, -s, list.x(i), list.y(i)], style: paint(list.color(i)), attrs: {} };
          children.push(node);
        }
      } else textRuns(list, children);
    }
    await images(false);
    rects(page.foreground);
    const group: GroupNode = { kind: 'group', tag: 'g', id: `page${number}`, children, style: {}, attrs: {}, ...(top && { transform: [1, 0, 0, 1, 0, top] as const }) };
    scene.children.push(group);
    top += page.height;
  }
  return scene;
}

/** The document as SVG text. */
export async function documentToSvg(doc: WordDocument, fonts: FontSet): Promise<string> {
  return writeSvg(await documentToScene(doc, fonts));
}
