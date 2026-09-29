// What each kind of document can express. The chrome disables commands a format can't
// represent (no font colors in Markdown, no editing in a PDF), so the same menus and toolbars
// serve every format without lying about what will survive a save.

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
  bookmarks: boolean;
  comments: boolean;
  footnotes: boolean;
  /** Pages, sections, breaks, columns, headers/footers, page numbers, text boxes. */
  pageLayout: boolean;
  trackChanges: boolean;
  codeBlocks: boolean;
  horizontalRule: boolean;
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
  bookmarks: true,
  comments: true,
  footnotes: true,
  pageLayout: true,
  trackChanges: true,
  codeBlocks: false,
  horizontalRule: true,
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
  bookmarks: false,
  comments: false,
  footnotes: false,
  pageLayout: false,
  trackChanges: false,
  codeBlocks: false,
  horizontalRule: false,
};

export const FORMATS: Record<DocumentKind, FormatProfile> = {
  docx: {
    ...RICH,
    kind: 'docx',
    label: 'Word Document',
    extensions: ['.docx', '.docm', '.dotx', '.doc'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  odt: {
    ...RICH,
    kind: 'odt',
    label: 'OpenDocument Text',
    extensions: ['.odt'],
    mime: 'application/vnd.oasis.opendocument.text',
  },
  rtf: {
    ...RICH,
    kind: 'rtf',
    label: 'Rich Text Format',
    extensions: ['.rtf'],
    mime: 'application/rtf',
    trackChanges: false,
    comments: false,
  },
  html: {
    ...RICH,
    kind: 'html',
    label: 'Web Page',
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
  md: {
    ...NOTHING,
    kind: 'md',
    label: 'Markdown',
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
  txt: {
    ...NOTHING,
    kind: 'txt',
    label: 'Plain Text',
    extensions: ['.txt', '.text'],
    mime: 'text/plain',
  },
  pdf: {
    ...NOTHING,
    kind: 'pdf',
    label: 'PDF',
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
export const CONVERT_ORDER: DocumentKind[] = ['docx', 'odt', 'html', 'pdf', 'md', 'txt'];

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
  switch (action.kind) {
    case 'dashboard':
    case 'convert':
    case 'new':
    case 'open':
    case 'openSample':
    case 'openSaved':
    case 'openCloud':
    case 'saveToCloud':
    case 'signIn':
    case 'signOut':
    case 'clearLocalData':
    case 'download':
    case 'print':
    case 'printPreview':
    case 'viewMode':
    case 'zoom':
    case 'zoomBy':
    case 'toggleGrid':
    case 'toggleRuler':
    case 'toggleFormattingMarks':
      return true;
    case 'setFormMode':
      return profile.kind === 'pdf';
    // Rooms share a Word document; a PDF has no text selection to copy or select yet.
    case 'collaborate':
      return profile.kind === 'docx';
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
