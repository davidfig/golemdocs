# Chunked storage and delta uploads

A document of 2 MiB or more is not saved as one blob, here or on the server. It is cut into chunks by its content, only the chunks that
changed are written and sent, and a save of a 50 MB file after a small edit moves a few megabytes. Nothing here is specific to a format:
it works on the bytes a save produces (a `.wdoc`, a `.docx`, a picture, a large text file).

## Chunks (`client/src/storage/chunker.ts`)

FastCDC-style content-defined chunking: a gear hash of the last few bytes decides where a chunk ends, so an insert or a delete moves the cuts
near it and the ones after it fall where they did. Sizes are 128 KiB at least, 2 MiB at most, about 0.5 to 1 MiB on average. Each chunk is named
by its SHA-256. The algorithm is called `cdc1`, goes in every manifest, and a test pins where it cuts a fixed buffer: changing it would make
stored chunks differ from what a save of the same file makes.

On the real 49 MB, 500,000-line log (`.cache/large-text/app.log`): 40 chunks, cut and hashed in about 90 ms; a typed character in the middle, a
new first line, or 1 KB deleted each change 2 chunks (about 2.6 MB of 49 MB).

## This browser (`client/src/storage/local.ts`, IndexedDB version 5)

`manifests` (document id → chunk hashes in order, their lengths, and `syncedHashes`), `chunks` (hash → bytes) and `chunkRefs` (hash → how many
documents hold it; a chunk is deleted when the last one lets go). `getSaved` puts the chunks back together, so every caller (open, search, link
rewriting, the assistant, Download All) is unchanged; a document under 2 MiB stays one value in `bytes`, and an old whole-file entry is converted
the next time it is saved. A save chunks before its transaction, then in one transaction writes the new chunks, adjusts the counts and the manifest.
If a chunk it counted on has gone (another tab saved), it starts again with nothing assumed.

## The server (`server/src/fileStore.ts`)

A chunked document is still at `<owner>/<doc>.docx`, but that object is a small JSON manifest (marked `chunked` in its metadata), and its chunks
are `<owner>/<doc>.chunks/<sha-256>`. Chunks belong to one document, so there is no counting and nothing is observable across people; deleting
the document deletes the prefix. Every reader of a file (the download, a room, search, the search index) goes through `fileStore`, so none of
them knows which kind a document is; a whole file is exactly as before.

A **delta upload** is `POST /api/documents` or `PUT /api/documents/:id` with content type `application/vnd.golemdocs.delta`: a 4-byte length, JSON
`{ manifest, supplied }`, then the supplied chunks' bytes. The server checks the sizes, checks each supplied chunk's SHA-256, requires every other
chunk of the manifest to be in the manifest it replaces (else `400` with code `missing-chunks`), writes the chunks, then the manifest with the same
etag condition and the same `updated_at` check as a whole-file save, and finally deletes the chunks the old manifest had and the new one does not.
A save that fails removes the chunks it brought that nobody names. A room saves the file whole, which ends the chunks.

## Uploading (`client/src/library.ts`, `cloud.ts`)

`uploadToCloud` sends a chunked document as chunks, leaving out those in `syncedHashes` (what the cloud is known to have: set by the last upload or
download). If the server says it lacks some, everything goes once. A document under 2 MiB, and the batch upload used for imports, are whole files as
before; a chunked document is left out of a batch and goes the single way. `uploadShared` (documents others own) does the same with the chunks
of its last upload this session.

## Not done

Downloads are still whole (the server reassembles; a second computer fetches the full file). The 50 MiB limit on a document stands, since the first
upload is one request. Autosave timing is unchanged: a save of a big file now costs a scan of it (about 90 ms) and a few megabytes, so it
did not need slowing down.
