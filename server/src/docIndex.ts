// GET /api/documents/:id/index: a document's full-text search index (see docx/src/search), kept in R2
// next to its file so a second computer fetches it instead of downloading and parsing the .docx.
//
// It is made lazily, on the first request after the document changed, never on a save (an autosave
// must not pay for a whole document; see search.ts). The stored object is stamped with the version
// of the index format and the catalogue row's `updated_at` (the server's clock, which every save
// raises, the room's too), and is used only while both still match.

import {
  INDEX_VERSION,
  WordDocument,
  buildIndex,
  encodeIndex,
  isPlainText,
  paragraphSegments,
  textSegments,
} from "@golemdocs/docx";
import type { Env } from "./cf.ts";
import { HttpError } from "./http.ts";
import { readDocument } from "./fileStore.ts";
import { storedDocx } from "./stored.ts";
import { indexKey } from "./keys.ts";

/** Documents bigger than this aren't indexed (the same limit as the assistant's search). */
const MAX_BYTES = 6_000_000;

const headers = (size: number, at: number): Record<string, string> => ({
  "content-type": "application/octet-stream",
  "content-length": String(size),
  "x-index-at": String(at),
  etag: `"${INDEX_VERSION}-${at}"`,
  "cache-control": "private, no-cache",
  "x-content-type-options": "nosniff",
});

/** The index of the document whose row is `row`, owned by `ownerId`: the stored one if it is current, else a new one. */
export async function documentIndex(
  env: Env,
  ownerId: string,
  row: { id: string; r2_key: string; updated_at: number },
): Promise<Response> {
  const key = indexKey(ownerId, row.id);
  const at = row.updated_at;
  const stored = await env.FILES.get(key);
  if (
    stored &&
    stored.customMetadata?.v === String(INDEX_VERSION) &&
    stored.customMetadata?.at === String(at)
  ) {
    return new Response(stored.body, { headers: headers(stored.size, at) });
  }
  // Not there, or for another version of the document or of the format: make it again.
  await stored?.body?.cancel();
  // The file whole, however it is kept (see fileStore.ts).
  const bytes = await readDocument(env, row.r2_key, ownerId, row.id, MAX_BYTES);
  if (!bytes) throw new HttpError(404, "document file is missing");
  if (bytes === "too-large")
    throw new HttpError(413, "document too large to index");
  let encoded: Uint8Array;
  try {
    // A plain text file is kept as it is: its lines are its paragraphs.
    if (isPlainText(bytes))
      encoded = await encodeIndex(buildIndex(textSegments(bytes)));
    else {
      // The app keeps its own wrapper around the .docx: a wrapper with no document in it has no text here, and the page reads the document itself.
      const docx = await storedDocx(bytes);
      if (!docx) throw new Error("no flowing document to read");
      encoded = await encodeIndex(
        buildIndex(paragraphSegments(await WordDocument.read(docx))),
      );
    }
  } catch (error) {
    console.error("indexing failed", error);
    throw new HttpError(422, "the document could not be read");
  }
  await env.FILES.put(
    key,
    encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer,
    {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { v: String(INDEX_VERSION), at: String(at) },
    },
  );
  return new Response(encoded, { headers: headers(encoded.byteLength, at) });
}
