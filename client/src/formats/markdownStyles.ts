// The paragraph, character and table styles Markdown documents use (headings, quotes, code...).
// Apart from the Markdown reader and writer so that formatting commands can define a style
// without loading them.

import type { Style } from '@golemdocs/docx';

const MONO = 'Courier New';
export const MONO_FONTS = { ascii: MONO, hAnsi: MONO, eastAsia: MONO, cs: MONO };

/** Definitions of the styles Markdown documents use (headings, quotes, code, lists…), by id. */
export function styleFor(id: string): Style | undefined {
  const heading = /^Heading([1-6])$/.exec(id);
  if (heading) {
    const level = Number(heading[1]);
    const size = [32, 26, 24, 22, 22, 22][level - 1];
    return {
      type: 'paragraph',
      id,
      name: `heading ${level}`,
      basedOn: 'Normal',
      next: 'Normal',
      paragraphProperties: {
        keepNext: true,
        keepLines: true,
        spacing: { before: level === 1 ? 240 : 40, after: level === 1 ? 240 : 0 },
        outlineLevel: level - 1,
      },
      runProperties: {
        fonts: { ascii: 'Calibri Light', hAnsi: 'Calibri Light', eastAsia: 'Calibri Light', cs: 'Times New Roman' },
        color: { val: level === 3 || level === 6 ? '1F3763' : '2F5496' },
        ...(level === 4 ? { italic: true } : {}),
        size,
        sizeCs: size,
      },
      attrs: {},
    };
  }
  switch (id) {
    case 'Quote':
      return {
        type: 'paragraph',
        id,
        name: 'Quote',
        basedOn: 'Normal',
        next: 'Normal',
        paragraphProperties: {
          spacing: { before: 120, after: 120 },
          indent: { left: 720 },
          borders: { left: { val: 'single', sz: 18, space: 8, color: 'BFBFBF' } },
        },
        runProperties: { italic: true, color: { val: '595959' } },
        attrs: {},
      };
    case 'Code':
      return {
        type: 'paragraph',
        id,
        name: 'Code',
        basedOn: 'Normal',
        paragraphProperties: {
          spacing: { before: 0, after: 0, line: 240, lineRule: 'auto' },
          shading: { val: 'clear', color: 'auto', fill: 'F2F2F2' },
        },
        runProperties: { fonts: MONO_FONTS, size: 20, sizeCs: 20 },
        attrs: {},
      };
    case 'CodeOutput':
      return {
        type: 'paragraph',
        id,
        name: 'Code Output',
        basedOn: 'Normal',
        paragraphProperties: {
          spacing: { before: 0, after: 0, line: 240, lineRule: 'auto' },
          borders: { left: { val: 'single', sz: 12, space: 6, color: 'BFBFBF' } },
          indent: { left: 120 },
        },
        runProperties: { fonts: MONO_FONTS, size: 20, sizeCs: 20, color: { val: '595959' } },
        attrs: {},
      };
    case 'InlineCode':
      return {
        type: 'character',
        id,
        name: 'Inline Code',
        basedOn: 'DefaultParagraphFont',
        runProperties: { fonts: MONO_FONTS, shading: { val: 'clear', color: 'auto', fill: 'F2F2F2' } },
        attrs: {},
      };
    case 'ImagePlaceholder':
      return {
        type: 'character',
        id,
        name: 'Image Placeholder',
        basedOn: 'DefaultParagraphFont',
        runProperties: { italic: true, color: { val: '7F7F7F' } },
        attrs: {},
      };
    case 'ListParagraph':
      return {
        type: 'paragraph',
        id,
        name: 'List Paragraph',
        basedOn: 'Normal',
        paragraphProperties: { indent: { left: 720 }, contextualSpacing: true },
        attrs: {},
      };
    case 'Hyperlink':
      return {
        type: 'character',
        id,
        name: 'Hyperlink',
        basedOn: 'DefaultParagraphFont',
        runProperties: { color: { val: '0563C1', themeColor: 'hyperlink' }, underline: { val: 'single' } },
        attrs: {},
      };
    case 'TableGrid':
      return {
        type: 'table',
        id,
        name: 'Table Grid',
        basedOn: 'TableNormal',
        paragraphProperties: { spacing: { after: 0, line: 240, lineRule: 'auto' } },
        tableProperties: {
          borders: Object.fromEntries(
            ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => [side, { val: 'single', sz: 4, space: 0, color: 'auto' }]),
          ),
        },
        attrs: {},
      };
  }
  return undefined;
}
