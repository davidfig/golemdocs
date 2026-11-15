// What Afterward keeps about a document beyond its comments (docs/afterward.md §5), and its settings. Kept in this browser's
// storage, per document: who the piece is for, which threads are Afterward's and what it holds back, the paragraphs' attention,
// and the choices the writer said were on purpose. Losing it loses little: the comments are the review. Wrapped in try/catch,
// since storage can be blocked.

import type { Attention, JournalEntry, Outline } from './prompts.ts';

export interface ThreadRecord {
  kind: 'moment' | 'study' | 'quotes' | 'book';
  /** The words the thread is on, and its paragraph, when the readers last read it. */
  passage: string;
  paragraph: string;
  /** A moment: Afterward's first reaction, kept back until the writer answers. */
  reaction?: string;
  revealed?: boolean;
  /** A study: what it asks. */
  pattern?: string;
  exercise?: string;
}

export interface ReviewRecord {
  v: 2;
  /** Who the writer says the piece is for ('' when they didn't say). */
  audience: string;
  threads: Record<string, ThreadRecord>;
  /** Attention by paragraph (its fingerprint, so it follows the text, not its place). */
  attention: Record<string, { level: Attention; note: string }>;
  /** Choices the writer said are on purpose. */
  notes: string[];
  /** Reverse outlines by the fingerprint of the piece (or chapter) they were made from: shown again while it is the same. */
  outlines?: Record<string, Outline>;
  /** The whole-book read's journal: an entry a chapter, in order, each with its chapter's fingerprint (a changed chapter, and those after it, are read again). */
  journal?: { chapter: string; title: string; entry: JournalEntry }[];
}

export const emptyRecord = (audience = ''): ReviewRecord => ({ v: 2, audience, threads: {}, attention: {}, notes: [] });

const PREFIX = 'golem.afterward.review.';

export function loadRecord(doc: string): ReviewRecord | null {
  try {
    const raw = localStorage.getItem(PREFIX + doc);
    const value = raw ? (JSON.parse(raw) as ReviewRecord) : null;
    // A record from before Afterward was one voice (v1) is left: its readers' threads still read as comments.
    return value?.v === 2 ? { ...emptyRecord(), ...value } : null;
  } catch {
    return null;
  }
}

export function saveRecord(doc: string, record: ReviewRecord): void {
  try {
    localStorage.setItem(PREFIX + doc, JSON.stringify(record));
  } catch {
    /* storage unavailable: the review still works for this visit */
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
