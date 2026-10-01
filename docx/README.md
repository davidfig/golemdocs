# @golemdocs/docx

Code shared by client and server. Currently: a from-scratch, dependency-free DOCX reader and writer.

```ts
import { WordDocument, StyleResolver, ListCounter } from '@golemdocs/docx';

const doc = await WordDocument.read(bytes);      // Uint8Array of a .docx
doc.body;                                        // paragraphs, tables, content controls, ...
const bytesOut = await doc.write();

const blank = await WordDocument.create();       // Word's Normal template, Letter, 1" margins
```

## Layers

| Layer | Files | Notes |
|---|---|---|
| ZIP | `src/zip/` | Central-directory reader with lazy, CRC-checked inflate; writer copies untouched entries without recompressing. Deflate via the built-in Compression Streams API. |
| XML | `src/xml/` | Fast string parser to a plain tree, namespace prefixes normalized (`w:`, `r:`, `wp:`, `a:`, `pic:`), iterative serializer. |
| OPC | `src/opc/` | Parts, content types, relationships. Parts nobody changes are written back byte-for-byte. |
| Model | `src/model/` | Typed document model in OOXML units (twips, half-points, EMU). `StyleResolver` computes effective formatting; `ListCounter` produces list labels. |
| DOCX | `src/docx/` | Schema-ordered property codec, content, styles, numbering, headers/footers, images, blank documents. |

Unmodeled content is never dropped: unknown elements are kept (`extra`, `Raw`, `Wrapper`) and written back in schema-valid order, so open → save doesn't lose anything Word put there.

## Tests

```sh
pnpm --filter @golemdocs/docx corpus     # once: fetch Apache POI's .docx test corpus into .cache/
pnpm --filter @golemdocs/docx test
pnpm --filter @golemdocs/docx roundtrip  # per-part diff report for every corpus document
```
