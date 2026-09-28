// Defaults for a new document: Word's Normal template (the Calibri-era defaults, matching
// the font set the renderer ships), US Letter with 1" margins.

import type { Preserved, SectionProperties, Style, StyleSheet } from '../model/types.ts';
import { NS } from '../xml/namespaces.ts';
import { el, serializeXml } from '../xml/xml.ts';

/** A style child we don't model (uiPriority, qFormat, ...), placed by schema order. */
const pre = (name: string, value?: string | number): Preserved => ({
  xml: el(name, value === undefined ? {} : { 'w:val': value }),
  after: null,
});
const QUICK = [pre('w:qFormat')];
const HIDDEN = [pre('w:semiHidden'), pre('w:unhideWhenUsed')];

const heading = (level: number, size: number, color: string, before: number): Style => ({
  type: 'paragraph',
  id: `Heading${level}`,
  name: `heading ${level}`,
  basedOn: 'Normal',
  next: 'Normal',
  paragraphProperties: { keepNext: true, keepLines: true, spacing: { before, after: 0 }, outlineLevel: level - 1 },
  runProperties: {
    fonts: { ascii: 'Calibri Light', hAnsi: 'Calibri Light', eastAsia: 'Calibri Light', cs: 'Times New Roman' },
    color: { val: color },
    size,
    sizeCs: size,
  },
  attrs: {},
  extra: [pre('w:uiPriority', 9), ...QUICK],
});

export function BLANK_STYLES(): StyleSheet {
  return {
    rootAttrs: { 'xmlns:w': NS.w, 'xmlns:r': NS.r },
    defaultRunProperties: {
      fonts: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Calibri', cs: 'Times New Roman' },
      size: 22,
      sizeCs: 22,
      lang: { val: 'en-US', eastAsia: 'en-US', bidi: 'ar-SA' },
    },
    defaultParagraphProperties: { spacing: { after: 160, line: 259, lineRule: 'auto' } },
    styles: [
      { type: 'paragraph', id: 'Normal', name: 'Normal', isDefault: true, attrs: {}, extra: QUICK },
      heading(1, 32, '2F5496', 240),
      heading(2, 26, '2F5496', 40),
      heading(3, 24, '1F3763', 40),
      {
        type: 'paragraph',
        id: 'Title',
        name: 'Title',
        basedOn: 'Normal',
        next: 'Normal',
        paragraphProperties: { spacing: { after: 0, line: 240, lineRule: 'auto' }, contextualSpacing: true },
        runProperties: {
          fonts: { ascii: 'Calibri Light', hAnsi: 'Calibri Light', eastAsia: 'Calibri Light', cs: 'Times New Roman' },
          kern: 28,
          size: 56,
          sizeCs: 56,
        },
        attrs: {},
        extra: [pre('w:uiPriority', 10), ...QUICK],
      },
      {
        type: 'paragraph',
        id: 'ListParagraph',
        name: 'List Paragraph',
        basedOn: 'Normal',
        paragraphProperties: { indent: { left: 720 }, contextualSpacing: true },
        attrs: {},
        extra: [pre('w:uiPriority', 34), ...QUICK],
      },
      {
        type: 'character',
        id: 'DefaultParagraphFont',
        name: 'Default Paragraph Font',
        isDefault: true,
        attrs: {},
        extra: [pre('w:uiPriority', 1), ...HIDDEN],
      },
      {
        type: 'character',
        id: 'Hyperlink',
        name: 'Hyperlink',
        basedOn: 'DefaultParagraphFont',
        runProperties: { color: { val: '0563C1', themeColor: 'hyperlink' }, underline: { val: 'single' } },
        attrs: {},
        extra: [pre('w:uiPriority', 99), pre('w:unhideWhenUsed')],
      },
      {
        type: 'table',
        id: 'TableNormal',
        name: 'Normal Table',
        isDefault: true,
        tableProperties: {
          indent: { w: '0', type: 'dxa' },
          cellMargins: {
            top: { w: '0', type: 'dxa' },
            left: { w: '108', type: 'dxa' },
            bottom: { w: '0', type: 'dxa' },
            right: { w: '108', type: 'dxa' },
          },
        },
        attrs: {},
        extra: [pre('w:uiPriority', 99), ...HIDDEN],
      },
      {
        type: 'table',
        id: 'TableGrid',
        name: 'Table Grid',
        basedOn: 'TableNormal',
        paragraphProperties: { spacing: { after: 0, line: 240, lineRule: 'auto' } },
        tableProperties: {
          borders: Object.fromEntries(
            ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => [
              side,
              { val: 'single', sz: 4, space: 0, color: 'auto' },
            ]),
          ),
        },
        attrs: {},
        extra: [pre('w:uiPriority', 39)],
      },
      {
        type: 'numbering',
        id: 'NoList',
        name: 'No List',
        isDefault: true,
        attrs: {},
        extra: [pre('w:uiPriority', 99), ...HIDDEN],
      },
    ],
  };
}

export function BLANK_SETTINGS(): string {
  return serializeXml(
    el('w:settings', { 'xmlns:w': NS.w }, [
      el('w:zoom', { 'w:percent': 100 }),
      el('w:defaultTabStop', { 'w:val': 720 }),
      el('w:characterSpacingControl', { 'w:val': 'doNotCompress' }),
      el('w:compat', {}, [
        // Without this Word opens the file in Compatibility Mode.
        el('w:compatSetting', {
          'w:name': 'compatibilityMode',
          'w:uri': 'http://schemas.microsoft.com/office/word',
          'w:val': 15,
        }),
      ]),
    ]),
  );
}

export function BLANK_SECTION(): SectionProperties {
  return {
    headers: [],
    footers: [],
    pageSize: { w: 12240, h: 15840 },
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 },
    columns: { space: 720 },
    docGrid: { linePitch: 360 },
    attrs: {},
  };
}
