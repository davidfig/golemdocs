// What the keeper hands an update (docs/live-blocks.md §6): the sources a document's blocks name, as stored, found from where
// that document is. The update itself (reading the document, turning each source into a result, writing it again) runs in
// the live worker (liveWorker.ts), or on the page where there is none (stored.ts, `updateFromStored`). Only what must stay
// on the page comes back here: the vault graph, scripts (their sandbox is the page's), and PDF exports (the layout worker's).
// Types only, so the keeper can name them without loading the live chunk.

import type { LiveOptions } from './owner.ts';
import type { LiveResult } from './result.ts';
import type { UpdateReport } from './update.ts';

/** A source as stored, with the key that names its document (for asking for its PDF export). */
export interface StoredSource {
  name: string;
  key: string;
  stored: Uint8Array;
  /** It shows, through its own blocks, the document being updated: the block says so instead. */
  cycle?: boolean;
}

export interface StoredLookup {
  /** The source an address's title names, or null. */
  file(title: string): Promise<StoredSource | null>;
  /** A folder's documents, for built-in blocks (never the document being updated, nor one that shows it). */
  folder?(path: string): Promise<StoredSource[] | null>;
  /** A document exported as a PDF, from its stored bytes; null when that can't be done now. */
  exportPdf?(key: string, stored: Uint8Array): Promise<Uint8Array | null>;
  /** A script's result (docs/live-blocks.md §8). */
  script?(path: string): Promise<LiveResult>;
  /** A button block's label. */
  button?(path: string): Promise<LiveResult>;
}

export interface UpdateOutcome {
  /** The document's new bytes, or null when no block changed. */
  bytes: Uint8Array | null;
  report: UpdateReport;
}

/** Brings a stored document's blocks up to date from what `lookup` hands out. */
export type StoredUpdater = (bytes: Uint8Array, name: string, lookup: StoredLookup, options: LiveOptions) => Promise<UpdateOutcome>;
