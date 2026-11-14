// SPDX-License-Identifier: MIT
// The document's XMP metadata stream (§14.3.2), which PDF/UA asks for: its title and language, the
// tools that made it and, when it conforms, the PDF/UA identification (ISO 14289-1, 5).

import { N, PdfDict, PdfStream } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';

export interface XmpOptions {
  title?: string;
  /** A BCP 47 tag. */
  lang?: string;
  /** The application the document was made in. */
  creator?: string;
  producer?: string;
  /** Declare the file PDF/UA-1. Only for a file that meets it. */
  pdfua?: boolean;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Sets the catalog's Metadata to an XMP packet with these properties. */
export function setXmpMetadata(doc: PdfDocument, options: XmpOptions): void {
  const lines = ['<dc:format>application/pdf</dc:format>'];
  if (options.title) lines.push(`<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escape(options.title)}</rdf:li></rdf:Alt></dc:title>`);
  if (options.lang) lines.push(`<dc:language><rdf:Bag><rdf:li>${escape(options.lang)}</rdf:li></rdf:Bag></dc:language>`);
  if (options.creator) lines.push(`<xmp:CreatorTool>${escape(options.creator)}</xmp:CreatorTool>`);
  if (options.producer) lines.push(`<pdf:Producer>${escape(options.producer)}</pdf:Producer>`);
  if (options.pdfua) lines.push('<pdfuaid:part>1</pdfuaid:part>');
  const xml = [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">',
    ...lines,
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
  doc.catalog.set('Metadata', doc.add(new PdfStream(new PdfDict({ Type: N('Metadata'), Subtype: N('XML') }), new TextEncoder().encode(xml))));
}
