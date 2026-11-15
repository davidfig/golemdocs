// What Afterward keeps about a document (docs/afterward.md §5), and the key. Kept in this browser's storage, per document, not
// in the document: the editor's notes in the margin, its reading of the piece, which paragraphs it has read, and the notes the
// writer dismissed. A note the writer wants to keep is pinned, and becomes an ordinary comment in the document. Losing this
// loses little. Wrapped in try/catch, since storage can be blocked.

import type { Outline, Turn } from './prompts.ts';

/** One of the editor's notes in the margin, with the conversation under it. */
export interface EditorNote {
  id: string;
  /** The words it is on, found again in the text as it changes; '' for a whole paragraph. */
  quote: string;
  /** The fingerprint of the paragraph it is on, when it was made (to find a whole-paragraph note again). */
  paragraph: string;
  /** What the editor noticed; '' for a question the writer started. */
  note: string;
  /** Where it came from: reading along, the writer asking, or quotes found in the writer's notes. */
  from: 'read' | 'ask' | 'quotes';
  /** A change it suggests to the writer's own words: cut, move (after `after`), or a word to replace with one of `words`. */
  cut?: string;
  move?: string;
  after?: string;
  replace?: string;
  words?: string[];
  /** Exact words of the piece the last answer points at. */
  show?: string[];
  /** Passages from the writer's own notes, word for word (Find Quotes). */
  quotes?: { text: string; source: string; why: string }[];
  talk: Turn[];
  at: number;
}

export interface ReviewRecord {
  v: 3;
  /** The editor's one-line reading of the piece, shown above its notes. */
  readsAs: string;
  /** Fingerprints of the paragraphs it has read as they are (a changed paragraph is read again). */
  read: string[];
  notes: EditorNote[];
  /** Notes the writer dismissed ("words": note), so they aren't raised again. */
  dismissed: string[];
  /** Reverse outlines by the fingerprint of the piece (or chapter) they were made from: shown again while it is the same. */
  outlines?: Record<string, Outline>;
}

export const emptyRecord = (): ReviewRecord => ({ v: 3, readsAs: '', read: [], notes: [], dismissed: [] });

const PREFIX = 'golem.afterward.review.';

export function loadRecord(doc: string): ReviewRecord | null {
  try {
    const raw = localStorage.getItem(PREFIX + doc);
    const value = raw ? (JSON.parse(raw) as ReviewRecord) : null;
    // Records from before the margin editor (v1, v2) are left: their threads still read as comments.
    return value?.v === 3 ? { ...emptyRecord(), ...value } : null;
  } catch {
    return null;
  }
}

export function saveRecord(doc: string, record: ReviewRecord): void {
  try {
    localStorage.setItem(PREFIX + doc, JSON.stringify(record));
  } catch {
    /* storage unavailable: the notes still work for this visit */
  }
}

// --- The key: per device, never synced (settingsSync.ts lists the synced keys; it is not among them) ---------------------

/** The writer's Anthropic API key. A secret: it stays on this device and goes only to Anthropic. */
export const KEY_SETTING = 'golem.afterward.key';

export function getSetting(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function setSetting(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
