// What each kind of document can express. The chrome disables commands a format can't
// represent (no font colors in Markdown, no editing in a PDF), so the same menus and toolbars
// serve every format without lying about what will survive a save.

import { t } from '../i18n/index.ts';
import { TEXT_EXTENSIONS } from '../formats/textFiles.ts';
import type { Action, DocumentKind, Mark } from './actions.ts';

export interface FormatProfile {
  kind: DocumentKind;
  /** For Convert To and the title bar. */
  label: string;
  extensions: string[];
  mime: string;
  /** False for view-only formats: every editing command is disabled. */
  editable: boolean;
  /** Takes markup annotations (highlight, underline, strikeout, notes) even when not editable. */
  annotations: boolean;
  marks: readonly Mark[];
  fonts: boolean;
  fontSizes: boolean;
  colors: boolean;
  highlight: boolean;
  alignment: boolean;
  lineSpacing: boolean;
  lists: boolean;
  indent: boolean;
  borders: boolean;
  /** Paragraph styles offered in the style box, in order. Empty: no styles. */
  styles: readonly string[];
  tables: boolean;
  images: boolean;
  links: boolean;
  /** Equations: only where the format can hold them (Word documents). */
  math: boolean;
  bookmarks: boolean;
  comments: boolean;
  footnotes: boolean;
  /** Pages, sections, breaks, columns, headers/footers, page numbers, text boxes. */
  pageLayout: boolean;
  trackChanges: boolean;
  codeBlocks: boolean;
  horizontalRule: boolean;
  /** A picture: the picture tools (rotate, crop, resize, adjust) apply, and nothing else edits it. */
  imageTools: boolean;
  /** A vector drawing: the vector editor's tools apply, and undo and redo are the editor's own. */
  vectorTools: boolean;
  /** A file too big to be a document, shown in the large-text viewer: search, filter and copy, and nothing that edits, prints or converts. */
  largeText: boolean;
}

const WORD_STYLES = [
  'Normal',
  'No Spacing',
  'Title',
  'Subtitle',
  'Heading 1',
  'Heading 2',
  'Heading 3',
  'Heading 4',
  'Quote',
  'Intense Quote',
  'List Paragraph',
] as const;

const ALL_MARKS: readonly Mark[] = ['bold', 'italic', 'underline', 'strikethrough', 'superscript', 'subscript'];

const RICH: Omit<FormatProfile, 'kind' | 'label' | 'extensions' | 'mime'> = {
  editable: true,
  annotations: false,
  marks: ALL_MARKS,
  fonts: true,
  fontSizes: true,
  colors: true,
  highlight: true,
  alignment: true,
  lineSpacing: true,
  lists: true,
  indent: true,
  borders: true,
  styles: WORD_STYLES,
  tables: true,
  images: true,
  links: true,
  math: false,
  bookmarks: true,
  comments: true,
  footnotes: true,
  pageLayout: true,
  trackChanges: true,
  codeBlocks: false,
  horizontalRule: true,
  imageTools: false,
  vectorTools: false,
  largeText: false,
};

const NOTHING: Omit<FormatProfile, 'kind' | 'label' | 'extensions' | 'mime'> = {
  editable: true,
  annotations: false,
  marks: [],
  fonts: false,
  fontSizes: false,
  colors: false,
  highlight: false,
  alignment: false,
  lineSpacing: false,
  lists: false,
  indent: false,
  borders: false,
  styles: [],
  tables: false,
  images: false,
  links: false,
  math: false,
  bookmarks: false,
  comments: false,
  footnotes: false,
  pageLayout: false,
  trackChanges: false,
  codeBlocks: false,
  horizontalRule: false,
  imageTools: false,
  vectorTools: false,
  largeText: false,
};

/** What an HTML page can express; EPUB and MHTML hold the same content in a container. */
const WEB: Omit<FormatProfile, 'kind' | 'label' | 'extensions' | 'mime'> = {
  ...RICH,
  styles: ['Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Quote', 'Code'],
  marks: [...ALL_MARKS, 'code'],
  pageLayout: false,
  comments: false,
  footnotes: false,
  trackChanges: false,
  codeBlocks: true,
};

/** A grid of text: tables and nothing else. */
const GRID: Omit<FormatProfile, 'kind' | 'label' | 'extensions' | 'mime'> = { ...NOTHING, tables: true };

const MARKUP_MARKS: Mark[] = ['bold', 'italic', 'code', 'superscript', 'subscript'];

/** What the lightweight markup formats (LaTeX, AsciiDoc, reStructuredText, Org) can express: structure and simple marks. */
const MARKUP: Omit<FormatProfile, 'kind' | 'label' | 'extensions' | 'mime'> = {
  ...NOTHING,
  marks: MARKUP_MARKS,
  styles: ['Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Quote', 'Code'],
  lists: true,
  indent: true,
  tables: true,
  links: true,
  codeBlocks: true,
  horizontalRule: true,
};

/** A text file too big to be a document: read in the large-text viewer (see ../largeText). */
const LARGE_TEXT: Omit<FormatProfile, 'kind' | 'label' | 'extensions' | 'mime'> = { ...NOTHING, editable: false, largeText: true };

/** A vector drawing: looked at for now; the vector editor's tools come with it (see vector/). */
const VECTOR: Omit<FormatProfile, 'kind' | 'label' | 'extensions' | 'mime'> = { ...NOTHING, editable: false, vectorTools: true };

/** A picture opened as an image: looked at, and changed with the picture tools. */
const PICTURE: Omit<FormatProfile, 'kind' | 'label' | 'extensions' | 'mime'> = { ...NOTHING, editable: false, imageTools: true };

export const FORMATS: Record<DocumentKind, FormatProfile> = {
  docx: {
    ...RICH,
    kind: 'docx',
    get label() {
      return t('menus.format.docx');
    },
    math: true,
    extensions: ['.docx', '.docm', '.dotx', '.doc'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  odt: {
    ...RICH,
    kind: 'odt',
    get label() {
      return t('menus.format.odt');
    },
    extensions: ['.odt'],
    mime: 'application/vnd.oasis.opendocument.text',
  },
  rtf: {
    ...RICH,
    kind: 'rtf',
    get label() {
      return t('menus.format.rtf');
    },
    extensions: ['.rtf'],
    mime: 'application/rtf',
    trackChanges: false,
    comments: false,
  },
  html: {
    ...RICH,
    kind: 'html',
    get label() {
      return t('menus.format.html');
    },
    extensions: ['.html', '.htm'],
    mime: 'text/html',
    styles: ['Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Quote', 'Code'],
    marks: [...ALL_MARKS, 'code'],
    pageLayout: false,
    comments: false,
    footnotes: false,
    trackChanges: false,
    codeBlocks: true,
  },
  epub: {
    ...WEB,
    kind: 'epub',
    get label() {
      return t('menus.format.epub');
    },
    extensions: ['.epub'],
    mime: 'application/epub+zip',
  },
  mhtml: {
    ...WEB,
    kind: 'mhtml',
    get label() {
      return t('menus.format.mhtml');
    },
    extensions: ['.mhtml', '.mht'],
    mime: 'multipart/related',
  },
  md: {
    ...NOTHING,
    kind: 'md',
    get label() {
      return t('menus.format.md');
    },
    extensions: ['.md', '.markdown'],
    mime: 'text/markdown',
    marks: ['bold', 'italic', 'strikethrough', 'code'],
    styles: ['Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Quote', 'Code'],
    lists: true,
    indent: true,
    tables: true,
    links: true,
    codeBlocks: true,
    horizontalRule: true,
  },
  csv: {
    ...GRID,
    kind: 'csv',
    get label() {
      return t('menus.format.csv');
    },
    extensions: ['.csv'],
    mime: 'text/csv',
  },
  tsv: {
    ...GRID,
    kind: 'tsv',
    get label() {
      return t('menus.format.tsv');
    },
    extensions: ['.tsv', '.tab'],
    mime: 'text/tab-separated-values',
  },
  tex: { ...MARKUP, kind: 'tex', label: 'LaTeX', extensions: ['.tex', '.latex'], mime: 'application/x-tex', marks: [...MARKUP_MARKS, 'underline', 'strikethrough'] },
  adoc: { ...MARKUP, kind: 'adoc', label: 'AsciiDoc', extensions: ['.adoc', '.asciidoc', '.asc'], mime: 'text/asciidoc', marks: [...MARKUP_MARKS, 'underline', 'strikethrough'] },
  rst: { ...MARKUP, kind: 'rst', label: 'reStructuredText', extensions: ['.rst', '.rest'], mime: 'text/x-rst' },
  mediawiki: { ...MARKUP, kind: 'mediawiki', label: 'MediaWiki Markup', extensions: ['.wiki', '.mediawiki'], mime: 'text/x-wiki', marks: [...MARKUP_MARKS, 'underline', 'strikethrough'] },
  eml: { ...WEB, kind: 'eml', get label() { return t('menus.format.eml'); }, extensions: ['.eml'], mime: 'message/rfc822' },
  ipynb: { ...MARKUP, kind: 'ipynb', label: 'Jupyter Notebook', extensions: ['.ipynb'], mime: 'application/x-ipynb+json', marks: [...MARKUP_MARKS, 'underline', 'strikethrough'] },
  textile: { ...MARKUP, kind: 'textile', label: 'Textile', extensions: ['.textile'], mime: 'text/x-textile', marks: [...MARKUP_MARKS, 'underline', 'strikethrough'] },
  org: { ...MARKUP, kind: 'org', label: 'Org Mode', extensions: ['.org'], mime: 'text/x-org', marks: [...MARKUP_MARKS, 'underline', 'strikethrough'] },
  typst: { ...MARKUP, kind: 'typst', label: 'Typst', extensions: ['.typ'], mime: 'text/x-typst', marks: [...MARKUP_MARKS, 'underline', 'strikethrough'] },
  docbook: { ...MARKUP, kind: 'docbook', label: 'DocBook', extensions: ['.dbk', '.docbook'], mime: 'application/docbook+xml', marks: [...MARKUP_MARKS, 'underline', 'strikethrough'] },
  jats: { ...MARKUP, kind: 'jats', label: 'JATS', extensions: ['.nxml', '.jats'], mime: 'application/xml', marks: [...MARKUP_MARKS, 'underline', 'strikethrough'] },
  // An e-book of sections, paragraphs, quotes and tables: no lists or code blocks.
  fb2: { ...MARKUP, kind: 'fb2', label: 'FictionBook', extensions: ['.fb2'], mime: 'application/x-fictionbook+xml', marks: ['bold', 'italic', 'strikethrough', 'code', 'superscript', 'subscript'], lists: false, codeBlocks: false },
  // An outline: headings and nested lists of plain text.
  opml: { ...NOTHING, kind: 'opml', label: 'OPML', extensions: ['.opml'], mime: 'text/x-opml', styles: ['Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'], lists: true, indent: true },
  largetext: { ...LARGE_TEXT, kind: 'largetext', get label() { return t('menus.format.largetext'); }, extensions: [], mime: 'text/plain' },
  png: { ...PICTURE, kind: 'png', get label() { return t('menus.format.png'); }, extensions: ['.png', '.gif', '.bmp'], mime: 'image/png' },
  jpeg: { ...PICTURE, kind: 'jpeg', get label() { return t('menus.format.jpeg'); }, extensions: ['.jpg', '.jpeg'], mime: 'image/jpeg' },
  webp: { ...PICTURE, kind: 'webp', get label() { return t('menus.format.webp'); }, extensions: ['.webp'], mime: 'image/webp' },
  svg: { ...VECTOR, kind: 'svg', get label() { return t('menus.format.svg'); }, extensions: ['.svg'], mime: 'image/svg+xml' },
  svgz: { ...VECTOR, kind: 'svgz', get label() { return t('menus.format.svgz'); }, extensions: ['.svgz'], mime: 'image/svg+xml' },
  txt: {
    ...NOTHING,
    kind: 'txt',
    get label() {
      return t('menus.format.txt');
    },
    // The first is what a new text document is called; the rest are files that open as text and keep their own name.
    extensions: ['.txt', ...TEXT_EXTENSIONS.filter((e) => e !== 'txt').map((e) => `.${e}`)],
    mime: 'text/plain',
  },
  pdf: {
    ...NOTHING,
    kind: 'pdf',
    get label() {
      return t('menus.format.pdf');
    },
    extensions: ['.pdf'],
    mime: 'application/pdf',
    editable: false,
    // Its own pages take markup: highlights, underlines, strikeouts and notes.
    annotations: true,
    highlight: true,
    marks: ['underline', 'strikethrough'],
    comments: true,
  },
};

/** The formats a document can be converted to (File ▸ Convert To and the selector in the chrome), in order. */
export const CONVERT_ORDER: DocumentKind[] = ['docx', 'odt', 'rtf', 'html', 'epub', 'mhtml', 'csv', 'tsv', 'tex', 'adoc', 'rst', 'org', 'mediawiki', 'textile', 'typst', 'docbook', 'jats', 'fb2', 'opml', 'eml', 'ipynb', 'png', 'jpeg', 'webp', 'svg', 'svgz', 'pdf', 'md', 'txt'];

/** What a picture can be converted to: the picture types, and the document types that can hold it. */
export const PICTURE_CONVERT_ORDER: DocumentKind[] = ['png', 'jpeg', 'webp', 'svg', 'svgz', 'docx', 'pdf'];

/** What a vector drawing can be converted to: the vector and picture types, and the document types that can hold a picture of it. */
export const VECTOR_CONVERT_ORDER: DocumentKind[] = ['svg', 'svgz', 'png', 'jpeg', 'webp', 'docx', 'odt', 'rtf', 'html', 'pdf'];

/** The vector drawings' kinds. */
export const VECTOR_KINDS: readonly DocumentKind[] = ['svg', 'svgz'];

/** The pictures' kinds. */
export const PICTURE_KINDS: readonly DocumentKind[] = ['png', 'jpeg', 'webp'];

/** How the format list is grouped: the popular formats first, then the rest by type. */
export const FORMAT_GROUPS: { id: 'popular' | 'documents' | 'web' | 'data' | 'markup' | 'images' | 'vector'; kinds: DocumentKind[] }[] = [
  { id: 'popular', kinds: ['docx', 'pdf', 'html', 'md', 'txt'] },
  { id: 'documents', kinds: ['odt', 'rtf'] },
  { id: 'web', kinds: ['epub', 'fb2', 'mhtml'] },
  { id: 'data', kinds: ['csv', 'tsv'] },
  { id: 'markup', kinds: ['tex', 'typst', 'adoc', 'rst', 'org', 'mediawiki', 'textile', 'docbook', 'jats', 'opml'] },
  { id: 'images', kinds: ['png', 'jpeg', 'webp'] },
  { id: 'vector', kinds: ['svg', 'svgz'] },
];

/** The group a format is listed under. */
export function formatGroup(kind: DocumentKind): (typeof FORMAT_GROUPS)[number]['id'] {
  return (FORMAT_GROUPS.find((g) => g.kinds.includes(kind)) ?? FORMAT_GROUPS[0]).id;
}

/** The kinds a document of this kind can be switched to, grouped and in order: the document's own group first (an image lists the other images first), then the popular formats and the rest (its own kind included, if it isn't one of them). */
export function convertTargets(kind: DocumentKind): DocumentKind[] {
  if (kind === 'largetext') return ['largetext'];
  const order = PICTURE_KINDS.includes(kind) ? PICTURE_CONVERT_ORDER : VECTOR_KINDS.includes(kind) ? VECTOR_CONVERT_ORDER : CONVERT_ORDER;
  const all = order.includes(kind) ? order : [...order, kind];
  const own = FORMAT_GROUPS.find((g) => g.kinds.includes(kind));
  const rank = (k: DocumentKind) => {
    const group = FORMAT_GROUPS.find((g) => g.kinds.includes(k));
    if (!group) return 999;
    const position = group === own ? -1 : FORMAT_GROUPS.indexOf(group);
    return position * 100 + group.kinds.indexOf(k);
  };
  return [...all].sort((a, b) => rank(a) - rank(b));
}

/** The kind of a file, from its name; `fallback` when the extension isn't one we know. */
export function kindFromName(name: string, fallback: DocumentKind = 'docx'): DocumentKind {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return fallback;
  const ext = name.slice(dot).toLowerCase();
  for (const profile of Object.values(FORMATS)) if (profile.extensions.includes(ext)) return profile.kind;
  return fallback;
}

/** Every extension, for a file picker's `accept`. */
export function acceptList(): string {
  return Object.values(FORMATS)
    .flatMap((f) => f.extensions)
    .join(',');
}

/** Whether a document of this format can express the action at all. */
export function formatAllows(profile: FormatProfile, action: Action): boolean {
  // The viewer for big text files only looks: no printing, converting, sharing or document properties.
  if (profile.largeText) {
    switch (action.kind) {
      case 'print':
      case 'printPreview':
      case 'convert':
      case 'share':
        return false;
      case 'dialog':
        return action.name === 'find' || action.name === 'goTo';
    }
  }
  switch (action.kind) {
    case 'import':
    case 'convert':
    case 'new':
    case 'open':
    case 'openSample':
    case 'openSaved':
    case 'syncNow':
    case 'share':
    case 'signIn':
    case 'signOut':
    case 'subscribe':
    case 'manageSubscription':
    case 'toggleClip':
    case 'clearLocalData':
    case 'download':
    case 'downloadAll':
    case 'print':
    case 'printPreview':
    case 'viewMode':
    case 'zoom':
    case 'zoomBy':
    case 'toggleGrid':
    case 'togglePagesPanel':
    case 'toggleFilesPanel':
    case 'toggleRuler':
    case 'toggleFooter':
    case 'toggleFormattingMarks':
      return true;
    case 'setFormMode':
      return profile.kind === 'pdf';
    case 'image':
    case 'drawStyle':
      return profile.imageTools;
    case 'vector':
    case 'vectorStyle':
      return profile.vectorTools;
    // A PDF has no text selection to copy or select yet.
    case 'copy':
    case 'selectAll':
      return profile.kind !== 'pdf';
    case 'dialog':
      switch (action.name) {
        case 'find':
        case 'goTo':
        case 'wordCount':
        case 'options':
        case 'properties':
          return true;
        case 'replace':
        case 'pasteSpecial':
        case 'spelling':
        case 'dateTime':
          return profile.editable;
        case 'font':
          return profile.editable && (profile.fonts || profile.marks.length > 0);
        case 'paragraph':
          return profile.editable && (profile.alignment || profile.lineSpacing || profile.indent);
        case 'bulletsAndNumbering':
          return profile.editable && profile.lists;
        case 'bordersAndShading':
          return profile.editable && profile.borders;
        case 'columns':
        case 'tabs':
        case 'pageSetup':
        case 'pageNumbers':
          return profile.editable && profile.pageLayout;
        case 'styles':
          return profile.editable && profile.styles.length > 0;
      }
      return false;
  }
  if ((profile.imageTools || profile.vectorTools) && (action.kind === 'undo' || action.kind === 'redo')) return true;
  if (!profile.editable) {
    if (!profile.annotations) return false;
    switch (action.kind) {
      case 'undo':
      case 'redo':
      case 'setHighlight':
      case 'insertComment':
        return true;
      case 'toggleMark':
        return profile.marks.includes(action.mark);
    }
    return false;
  }
  switch (action.kind) {
    case 'undo':
    case 'redo':
    case 'cut':
    case 'paste':
    case 'insertText':
    case 'changeCase':
      return true;
    case 'toggleMark':
      return profile.marks.includes(action.mark);
    case 'setFont':
      return profile.fonts;
    case 'setFontSize':
    case 'growFont':
    case 'shrinkFont':
      return profile.fontSizes;
    case 'setColor':
      return profile.colors;
    case 'setHighlight':
      return profile.highlight;
    case 'clearFormatting':
    case 'formatPainter':
      return profile.marks.length > 0 || profile.fonts;
    case 'setStyle':
      return profile.styles.includes(action.style);
    case 'setAlignment':
      return profile.alignment;
    case 'setLineSpacing':
    case 'setParagraph':
      return profile.lineSpacing;
    case 'toggleList':
      return profile.lists;
    case 'indent':
      return profile.indent;
    case 'insertBreak':
      return action.break === 'line' || profile.pageLayout;
    case 'insertTable':
    case 'table':
      return profile.tables;
    case 'insertImage':
      return profile.images;
    case 'insertLink':
      return profile.links;
    case 'insertMath':
      return profile.math;
    case 'insertComment':
      return profile.comments;
    case 'insertFootnote':
      return profile.footnotes;
    case 'insertBookmark':
      return profile.bookmarks;
    case 'insertTextBox':
      return profile.pageLayout;
    case 'insertCodeBlock':
      return profile.codeBlocks;
    case 'insertHorizontalRule':
      return profile.horizontalRule;
    case 'toggleTrackChanges':
      return profile.trackChanges;
  }
}
