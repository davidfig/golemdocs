// SPDX-License-Identifier: MIT
// Pictures that people editing a document together add. Their bytes can't ride in the changes a room passes on (those are small
// and ordered), so each is kept by what it is: the part is named for the SHA-256 of its bytes. Two people can't give different
// pictures one name, a picture added twice is one part, and whoever needs a part they don't have asks the room for it by hash.

/** `word/media/h-<64 hex digits>.<extension>`. */
const PART = /^word\/media\/h-([0-9a-f]{64})\.([a-z0-9]{1,8})$/;

/** Every such part name in a text (the changes of a room, as JSON). */
export const SHARED_MEDIA_IN_TEXT = /word\/media\/h-[0-9a-f]{64}\.[a-z0-9]{1,8}/g;

export function sharedMediaPart(hash: string, extension: string): string {
  return `word/media/h-${hash}.${extension.replace(/^\./, '').toLowerCase()}`;
}

/** The hash a part is named for, or null for any other part. */
export function sharedMediaHash(part: string): string | null {
  return PART.exec(part)?.[1] ?? null;
}

/** The SHA-256 of bytes, as 64 lower-case hex digits. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
