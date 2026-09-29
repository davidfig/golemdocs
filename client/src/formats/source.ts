// Which document source a file becomes, by its extension (or, for a .wdoc, its bytes).

import type { DocumentSource } from '../layout/protocol.ts';
import { isTextName } from './textFiles.ts';
import { isWdoc } from './wdoc.ts';

const DOCX_FILE = /\.(docx|docm|dotx)$/i;
const DOC_FILE = /\.(doc|dot)$/i;
const ODT_FILE = /\.(odt|fodt)$/i;
const RTF_FILE = /\.rtf$/i;
const HTML_FILE = /\.(html?|xhtml)$/i;
const EPUB_FILE = /\.epub$/i;
const MHTML_FILE = /\.(mhtml?)$/i;
const CSV_FILE = /\.csv$/i;
const TSV_FILE = /\.(tsv|tab)$/i;
const TEX_FILE = /\.(tex|latex)$/i;
const ADOC_FILE = /\.(adoc|asciidoc|asc)$/i;
const RST_FILE = /\.(rst|rest)$/i;
const ORG_FILE = /\.org$/i;
const MEDIAWIKI_FILE = /\.(wiki|mediawiki)$/i;
const TEXTILE_FILE = /\.textile$/i;
const EML_FILE = /\.eml$/i;
const IPYNB_FILE = /\.ipynb$/i;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const PDF_FILE = /\.pdf$/i;
const MARKDOWN_FILE = /\.(md|markdown)$/i;
const TEXT_FILE = /\.(txt|text)$/i;
const WDOC_FILE = /\.wdoc$/i;

/**
 * The source for a file's bytes, or null when the extension isn't one we open. A .wdoc is
 * recognised by its bytes whatever its name: saved documents keep the name of the format they
 * are edited as ("Report.md") while their bytes hold the whole document.
 */
export function sourceFromFile(name: string, bytes: ArrayBuffer): DocumentSource | null {
  if (WDOC_FILE.test(name) || isWdoc(bytes)) return { kind: 'wdoc', name, bytes };
  if (DOCX_FILE.test(name)) return { kind: 'docx', name, bytes };
  if (DOC_FILE.test(name)) return { kind: 'doc', name, bytes };
  if (ODT_FILE.test(name)) return { kind: 'odt', name, bytes };
  if (RTF_FILE.test(name)) return { kind: 'rtf', name, bytes };
  if (HTML_FILE.test(name)) return { kind: 'html', name, bytes };
  if (EPUB_FILE.test(name)) return { kind: 'epub', name, bytes };
  if (MHTML_FILE.test(name)) return { kind: 'mhtml', name, bytes };
  if (CSV_FILE.test(name)) return { kind: 'csv', name, bytes };
  if (TSV_FILE.test(name)) return { kind: 'tsv', name, bytes };
  if (TEX_FILE.test(name)) return { kind: 'tex', name, bytes };
  if (ADOC_FILE.test(name)) return { kind: 'adoc', name, bytes };
  if (RST_FILE.test(name)) return { kind: 'rst', name, bytes };
  if (ORG_FILE.test(name)) return { kind: 'org', name, bytes };
  if (MEDIAWIKI_FILE.test(name)) return { kind: 'mediawiki', name, bytes };
  if (TEXTILE_FILE.test(name)) return { kind: 'textile', name, bytes };
  if (EML_FILE.test(name)) return { kind: 'eml', name, bytes };
  if (IPYNB_FILE.test(name)) return { kind: 'ipynb', name, bytes };
  if (IMAGE_FILE.test(name)) return { kind: 'image', name, bytes };
  if (PDF_FILE.test(name)) return { kind: 'pdf', name, bytes };
  if (MARKDOWN_FILE.test(name)) return { kind: 'md', name, bytes };
  if (TEXT_FILE.test(name) || isTextName(name)) return { kind: 'txt', name, bytes };
  return null;
}

/** Strips a known document extension from a file name. */
export function stem(name: string): string {
  if (isTextName(name)) return name.replace(/\.[^.]*$/, '');
  return name.replace(/\.(docx|docm|dotx|doc|odt|rtf|html?|mhtml?|epub|csv|tsv|png|jpe?g|webp|gif|bmp|svg|tex|latex|adoc|asciidoc|asc|rst|rest|org|wiki|mediawiki|textile|eml|ipynb|fodt|pdf|md|markdown|txt|text|wdoc)$/i, '');
}
