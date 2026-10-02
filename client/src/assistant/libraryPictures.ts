// The picture files saved in the person's library, for the assistant to list and look at
// (the `list_pictures` and `view_picture` tools). No storage here: the saved documents and the
// way to read one are passed in.

import { pictureForModel } from '../formats/imageForModel.ts';
import { sniffImage } from '../formats/images.ts';
import type { ToolResult } from './conversation.ts';

export interface SavedPicture {
  id: string;
  name: string;
  size: number;
}

const PICTURE_NAME = /\.(?:png|jpe?g|webp|gif)$/i;
const MAX_LISTED = 50;

/** The saved documents that are picture files, by their name. */
export const libraryPictures = <T extends SavedPicture>(docs: readonly T[]): T[] => docs.filter((d) => PICTURE_NAME.test(d.name));

/** The picture files in the library, one per line with the id to view it by. */
export function describeLibraryPictures(docs: readonly SavedPicture[]): string {
  const pictures = libraryPictures(docs);
  if (!pictures.length) return 'The library has no saved picture files.';
  const lines = pictures.slice(0, MAX_LISTED).map((d) => `id ${d.id}: ${d.name.slice(0, 120)} (${Math.max(1, Math.round(d.size / 1024))} KB)`);
  return `The library has ${pictures.length} saved picture file${pictures.length === 1 ? '' : 's'}:\n${lines.join('\n')}${pictures.length > MAX_LISTED ? `\n(${pictures.length - MAX_LISTED} more not listed)` : ''}`;
}

/** Looks at one saved picture: its prepared data URI with a line about it, or why it can't be shown. */
export async function viewLibraryPicture(docs: readonly SavedPicture[], id: unknown, read: (id: string) => Promise<ArrayBuffer | null>): Promise<ToolResult> {
  if (typeof id !== 'string') return 'Error: `id` must be text (use list_pictures to find it).';
  const doc = libraryPictures(docs).find((d) => d.id === id);
  if (!doc) return `Error: there is no saved picture with id ${id}.`;
  const buffer = await read(id).catch(() => null);
  if (!buffer) return `Error: "${doc.name}" could not be opened.`;
  const bytes = new Uint8Array(buffer);
  const image = sniffImage(bytes);
  if (!image) return `Error: "${doc.name}" is not a picture the assistant can look at.`;
  try {
    return { text: `Showing "${doc.name}" (${image.width} by ${image.height} pixels, ${image.type}).`, images: [await pictureForModel(bytes)] };
  } catch {
    return `Error: "${doc.name}" could not be prepared to show.`;
  }
}
