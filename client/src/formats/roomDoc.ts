// The document a room shares. The room's clients and server edit the document itself (what a .docx holds), but a room also
// has to say what the document is edited as (Markdown, HTML, ...) and keep what only that format can hold (front matter,
// a CSV's delimiter...), or the people who join would open it as Word, and the cloud's copy would lose both when the room
// ends. So a room's document is the app's own .wdoc, except for plain Word with nothing beside it, which stays a plain
// .docx exactly as it always was (so what reads and writes those is unchanged).

import type { Format } from './convert.ts';
import { isWdoc, readWdoc, writeWdoc, WDOC_VERSION, type Extensions } from './wdoc.ts';

/** What a room's document is. */
export interface RoomContent {
  /** The document, as .docx bytes. */
  docx: Uint8Array;
  /** What it is edited as, and what it was first made from. */
  lens: Format;
  origin: Format;
  extensions: Extensions;
}

const PICTURES: ReadonlySet<Format> = new Set(['png', 'jpeg', 'webp']);

/** Whether a document edited as this format is a picture. */
export const isPictureFormat = (format: Format): boolean => PICTURES.has(format);

/** What the changes sent to a room are: for a PDF's own pages, changes to the objects on them; for a picture, to the shapes drawn over it; for everything else, to the text. */
export const roomKind = (format: Format): 'doc' | 'objects' | 'layers' => (format === 'pdf' ? 'objects' : PICTURES.has(format) ? 'layers' : 'doc');

/** Formats whose each edit replaces the whole thing (a drawing), so that only one person at a time may edit: the room gives that right out as a lease. */
const ONE_AT_A_TIME: ReadonlySet<Format> = new Set(['svg', 'svgz']);

export const exclusiveRoom = (format: Format): boolean => ONE_AT_A_TIME.has(format);

/** Whether a document edited as this format can be in a room: every one can. */
export const roomable = (_format: Format): boolean => true;

const hasExtensions = (extensions: Extensions): boolean => Object.values(extensions).some((value) => value && Object.keys(value).length);

/** The bytes a room holds for a document. */
export async function writeRoomDocument({ docx, lens, origin, extensions }: RoomContent): Promise<Uint8Array> {
  if (lens === 'docx' && origin === 'docx' && !hasExtensions(extensions)) return docx;
  return writeWdoc({ manifest: { version: WDOC_VERSION, lens, origin, pagesCurrent: false }, document: docx, original: null, extensions });
}

/** The document in a room's bytes: a .wdoc, or (as every room used to hold) a plain .docx. */
export async function readRoomDocument(bytes: Uint8Array): Promise<RoomContent> {
  if (!isWdoc(bytes)) return { docx: bytes, lens: 'docx', origin: 'docx', extensions: {} };
  const wdoc = await readWdoc(bytes);
  if (!wdoc.document) throw new Error('the room has no document');
  return { docx: wdoc.document, lens: wdoc.manifest.lens, origin: wdoc.manifest.origin, extensions: wdoc.extensions };
}
