// The documents a search covers, as `SearchableDocument`s: every entry in the library (this
// browser's copies and the account's) and what others shared. Where bytes and indexes come from is
// passed in, so this stays free of the network and of storage.

import type { CloudDocument } from '../cloud.ts';
import type { LibraryEntry } from '../sync.ts';
import { opensFromCloud } from '../ui/dashboardFormat.ts';
import type { SearchableDocument } from './searchLibrary.ts';

export interface SourceDeps {
  /** The bytes of the browser's copy. */
  local(id: string): Promise<ArrayBuffer | null | undefined>;
  /** The .docx of an account document. */
  download(id: string): Promise<ArrayBuffer>;
  /** The account's index of one of its documents. */
  index(id: string): ReturnType<NonNullable<SearchableDocument['fromCloud']>>;
}

/** What `entry` is searched as: the account's copy when it is the one that opens (or is the same as the browser's), else the browser's. */
export function searchableEntry(entry: LibraryEntry, deps: SourceDeps): SearchableDocument {
  const fromCloud = entry.cloud !== null && (opensFromCloud(entry) || entry.state === 'synced');
  const cloudId = entry.cloud?.id;
  const stamp = fromCloud ? `c:${entry.cloud!.updatedAt}` : `l:${entry.local!.updatedAt}`;
  return {
    key: entry.key,
    name: entry.name,
    updatedAt: entry.updatedAt,
    size: entry.size,
    stamp,
    ...(!entry.local || opensFromCloud(entry) ? { remote: true as const } : {}),
    bytes: async () => (entry.local && !opensFromCloud(entry) ? await deps.local(entry.local.id) : null) ?? (await deps.download(cloudId!)),
    ...(fromCloud && cloudId && { fromCloud: () => deps.index(cloudId) }),
  };
}

/** A document someone shared: always the account's copy, and never in this browser. */
export function searchableShared(doc: CloudDocument, deps: SourceDeps): SearchableDocument {
  return {
    key: doc.id,
    name: doc.name,
    updatedAt: doc.updatedAt,
    size: doc.size,
    stamp: `c:${doc.updatedAt}`,
    remote: true,
    place: doc.owner?.name ?? doc.owner?.email ?? undefined,
    bytes: () => deps.download(doc.id),
    fromCloud: () => deps.index(doc.id),
  };
}

/** Everything searchable: the entries, then what was shared (skipping any that is also one of the entries). */
export function searchableDocuments(entries: readonly LibraryEntry[], shared: readonly CloudDocument[], deps: SourceDeps): SearchableDocument[] {
  const own = new Set(entries.flatMap((e) => (e.cloud ? [e.cloud.id] : [])));
  return [...entries.map((e) => searchableEntry(e, deps)), ...shared.filter((d) => !own.has(d.id)).map((d) => searchableShared(d, deps))];
}
