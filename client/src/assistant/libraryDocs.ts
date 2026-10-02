// Gives the assistant the person's other documents: every one in the account (and this browser's
// own), and those other people shared with them. Documents are fetched only when a tool needs
// them and kept for the session, so a second look at one costs nothing. Fetching is passed in
// (main.ts knows where a document's bytes are), so this has no network and no storage of its own.

import { WordDocument, paragraphSegments } from '@golemdocs/docx';
import { pictureForModel } from '../formats/imageForModel.ts';
import { collectImages } from '../formats/images.ts';
import { isWdoc, readWdoc } from '../formats/wdoc.ts';
import type { SearchAnswer } from './api.ts';
import type { ToolResult } from './conversation.ts';
import { describeHits, describeList, readSegments, resolveDocument, scoreDocument, termsOf, MAX_SCANNED, type Candidate, type Hit, type Segment } from './otherDocs.ts';

export interface StoredDocument extends Candidate {
  updatedAt: number;
  size: number;
  /** The id of its copy in the account, if it is one of the person's own and has one: the server's search covers those. */
  cloudId?: string;
  /** Whose it is, when it isn't theirs ("shared by …"). */
  place?: string;
  /** Its bytes: .docx from the account, or the app's own .wdoc from this browser. */
  load(): Promise<ArrayBuffer>;
}

/** Documents bigger than this aren't opened for a search or a read (they'd freeze the page, and aren't prose). */
const MAX_BYTES = 6_000_000;
const CONCURRENCY = 4;

/** The document in a stored document's bytes (a .docx, or this app's .wdoc around one); null when it has none (a PDF not turned into text yet). */
export async function wordDocumentFromBytes(bytes: ArrayBuffer): Promise<WordDocument | null> {
  const docx = isWdoc(bytes) ? (await readWdoc(new Uint8Array(bytes))).document : new Uint8Array(bytes);
  return docx ? WordDocument.read(docx) : null;
}

/** The paragraphs in a stored document's bytes; null when it has no text to read (a PDF not turned into text yet). */
export async function segmentsFromBytes(bytes: ArrayBuffer): Promise<Segment[] | null> {
  const doc = await wordDocumentFromBytes(bytes);
  return doc ? paragraphSegments(doc) : null;
}

/** Saved documents that are picture files (a picture is saved as a one-page document, named for its type). */
const PICTURE_NAME = /\.(?:png|jpe?g|webp|gif)$/i;
const MAX_LISTED_PICTURES = 50;

export class OtherDocuments {
  private readonly cache = new Map<string, Promise<Segment[] | null>>();

  /**
   * `list` answers with everything the person has, except the open document. `remote` is the
   * server's search by meaning (null when it can't be used): it covers the documents that have a
   * `cloudId`, and the rest are looked through here, by words.
   */
  constructor(
    private readonly list: () => Promise<StoredDocument[]>,
    private readonly remote: (query: string) => Promise<SearchAnswer | null> = async () => null,
  ) {}

  private async all(): Promise<StoredDocument[]> {
    return (await this.list()).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  /** The paragraphs of a document: null if it has none to read. Throws what went wrong. */
  private segments(doc: StoredDocument): Promise<Segment[] | null> {
    if (doc.size > MAX_BYTES) return Promise.reject(new Error(`"${doc.name}" is too big to read here.`));
    const key = `${doc.id}@${doc.updatedAt}`;
    let found = this.cache.get(key);
    if (!found) {
      found = doc.load().then(segmentsFromBytes);
      this.cache.set(key, found);
      // A failure isn't kept: the next try asks again.
      found.catch(() => this.cache.delete(key));
    }
    return found;
  }

  async describeAll(start: number, count: number): Promise<string> {
    const docs = await this.all();
    return describeList(
      docs.map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt, ...(d.place && { place: d.place }) })),
      start,
      count,
    );
  }

  async search(query: string): Promise<string> {
    const terms = termsOf(query);
    if (!terms.length) return 'Give some words to search for.';
    const docs = await this.all();
    const answer = await this.remote(query);
    const byCloudId = new Map(docs.filter((d) => d.cloudId).map((d) => [d.cloudId!, d]));
    // What the server covers is taken from its answer; everything else is read here.
    const hits: Hit[] = [];
    for (const hit of answer?.hits ?? []) {
      const doc = byCloudId.get(hit.id);
      if (doc) hits.push({ id: doc.id, name: doc.name, score: hit.score, where: { paragraph: hit.paragraph, text: hit.text } });
    }
    const scan = docs.filter((d) => !answer || !d.cloudId).slice(0, MAX_SCANNED);
    const found: Hit[] = [];
    let next = 0;
    const worker = async () => {
      for (let doc = scan[next++]; doc; doc = scan[next++]) {
        const segments = doc.size > MAX_BYTES ? null : await this.segments(doc).catch(() => null);
        // A document that can't be read can still be found by its name.
        const hit = scoreDocument(terms, doc, segments ?? []);
        if (hit) found.push(hit);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scan.length) }, worker));
    found.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const waiting = answer?.pending ? ` ${answer.pending} of the documents are still being prepared for searching, so search again in a moment if this misses one.` : '';
    return describeHits(query, [...hits, ...found], scan.length, docs.filter((d) => !answer || !d.cloudId).length) + waiting;
  }

  /** The paragraphs of the document `ref` names; a string saying why not, when it can't be had. */
  async paragraphs(ref: string): Promise<{ name: string; segments: Segment[] } | string> {
    const doc = resolveDocument(ref, await this.all());
    if (typeof doc === 'string') return doc;
    try {
      const segments = await this.segments(doc);
      return segments ? { name: doc.name, segments } : `"${doc.name}" has no text to read (it is a PDF that hasn't been turned into text, or a picture).`;
    } catch (e) {
      return `Could not read "${doc.name}": ${(e as Error).message}`;
    }
  }

  /** The saved picture files, one per line with the id to view each by. */
  async describePictureFiles(): Promise<string> {
    const pictures = (await this.all()).filter((d) => PICTURE_NAME.test(d.name));
    if (!pictures.length) return 'No saved picture files were found among the other documents.';
    const lines = pictures.slice(0, MAX_LISTED_PICTURES).map((d) => `- "${d.name.slice(0, 120)}" (id ${d.id})${d.place ? `, ${d.place}` : ''}`);
    const more = pictures.length > MAX_LISTED_PICTURES ? `\n(${pictures.length - MAX_LISTED_PICTURES} more not listed)` : '';
    return `${pictures.length} saved picture file${pictures.length === 1 ? '' : 's'} among the other documents (view one with source "library" and its id):\n${lines.join('\n')}${more}`;
  }

  /**
   * Looks at a picture in another document: the picture of a picture file, or the `number`th
   * picture (from 0) in any other document. Its data URI goes with a line about it; a string
   * says why not.
   */
  async picture(ref: string, number: number): Promise<ToolResult> {
    const doc = resolveDocument(ref, await this.all());
    if (typeof doc === 'string') return `Error: ${doc}`;
    if (doc.size > MAX_BYTES) return `Error: "${doc.name}" is too big to read here.`;
    try {
      const found = await wordDocumentFromBytes(await doc.load());
      const pictures = found ? [...(await collectImages(found)).values()] : [];
      const picture = pictures[number];
      if (!picture) return `Error: ${pictures.length ? `"${doc.name}" has ${pictures.length} picture${pictures.length === 1 ? '' : 's'} (0 to ${pictures.length - 1}), not ${number}.` : `"${doc.name}" has no pictures.`}`;
      return { text: `Showing picture ${number} of "${doc.name}" (${picture.width} by ${picture.height} pixels, ${picture.type}).`, images: [await pictureForModel(picture.bytes)] };
    } catch (e) {
      return `Error: could not look at "${doc.name}": ${(e as Error).message}`;
    }
  }

  async read(ref: string, start: number, count: number): Promise<string> {
    const found = await this.paragraphs(ref);
    return typeof found === 'string' ? found : readSegments(found.name, found.segments, start, count);
  }
}
