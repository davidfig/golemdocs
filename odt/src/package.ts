// Opening an OpenDocument package: the ZIP (or a flat .fodt XML file), its parts parsed with
// namespace prefixes normalised, and every other file loaded for pictures and embedded objects.

import { parseXml, ZipArchive, type XmlElement } from '@word/docx';
import { CONFIG_NS, MIME_TEXT, MIME_TEXT_TEMPLATE, ODF_NS, OdtError, childElements, firstChild, fragment, normalizeNamespaces } from './odf.ts';

export interface OdfPackage {
  /** office:document-content (or office:document for a flat file). */
  content: XmlElement;
  /** office:document-styles (the same element as content for a flat file), if present. */
  styles?: XmlElement;
  meta?: string;
  settings?: string;
  /** Every file in the package by path. */
  files: Map<string, Uint8Array>;
  /** Media types from META-INF/manifest.xml, by path (directories end in "/"). */
  mediaTypes: Map<string, string>;
  /** Non-ODF namespaces in use (prefix -> URI). */
  namespaces: Record<string, string>;
}

const decoder = new TextDecoder();

function parsePart(name: string, text: string, namespaces: Record<string, string>): XmlElement {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (e) {
    throw new OdtError(`${name} is not well-formed XML (${(e as Error).message})`);
  }
  Object.assign(namespaces, normalizeNamespaces(root));
  return root;
}

/** Whether the bytes look like XML text (a flat ODF file) rather than a ZIP. */
function looksLikeXml(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return bytes[i] === 0x3c; // '<'
}

export async function openPackage(bytes: Uint8Array): Promise<OdfPackage> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new OdtError('not an OpenDocument text file: the file is empty');
  const namespaces: Record<string, string> = {};
  if (looksLikeXml(bytes)) return openFlat(decoder.decode(bytes), namespaces);

  let zip: ZipArchive;
  try {
    zip = ZipArchive.read(bytes);
  } catch (e) {
    throw new OdtError(`not an OpenDocument text file (${(e as Error).message})`);
  }
  const files = new Map<string, Uint8Array>();
  for (const [name, entry] of zip.entries) {
    try {
      files.set(name, await entry.read());
    } catch (e) {
      // A corrupt picture shouldn't make the text unreadable; a corrupt part is reported below.
      if (/\.xml$/.test(name) || name === 'mimetype') throw new OdtError(`the file is damaged: ${(e as Error).message}`);
    }
  }
  const text = (name: string) => {
    const data = files.get(name);
    return data ? decoder.decode(data) : undefined;
  };

  const mimetype = text('mimetype')?.trim();
  if (mimetype !== undefined && mimetype !== MIME_TEXT && mimetype !== MIME_TEXT_TEMPLATE) {
    if (mimetype.startsWith('application/vnd.oasis.opendocument.')) {
      const kind = mimetype.slice('application/vnd.oasis.opendocument.'.length);
      throw new OdtError(`this is an OpenDocument ${kind} file, not a text document`);
    }
    throw new OdtError(`not an OpenDocument text file (mimetype "${mimetype.slice(0, 80)}")`);
  }
  const contentText = text('content.xml');
  if (contentText === undefined) {
    if (files.has('word/document.xml') || files.has('[Content_Types].xml')) throw new OdtError('this is a Word (.docx) file, not an OpenDocument text file');
    throw new OdtError('not an OpenDocument text file: content.xml is missing');
  }
  const content = parsePart('content.xml', contentText, namespaces);
  if (content.name !== 'office:document-content') throw new OdtError(`content.xml has an unexpected root <${content.name}>`);
  const stylesText = text('styles.xml');
  const styles = stylesText === undefined ? undefined : parsePart('styles.xml', stylesText, namespaces);

  const mediaTypes = new Map<string, string>();
  const manifestText = text('META-INF/manifest.xml');
  if (manifestText !== undefined) {
    try {
      const manifest = parseXml(manifestText);
      normalizeNamespaces(manifest);
      for (const entry of childElements(manifest, 'manifest:file-entry')) {
        const path = entry.attrs['manifest:full-path'];
        if (path && path !== '/') mediaTypes.set(path, entry.attrs['manifest:media-type'] ?? '');
      }
    } catch {
      // The manifest only supplies media types for preserved objects; guess them instead.
    }
  }
  checkBody(content);
  return { content, styles, meta: text('meta.xml'), settings: text('settings.xml'), files, mediaTypes, namespaces };
}

function openFlat(source: string, namespaces: Record<string, string>): OdfPackage {
  const root = parsePart('the document', source, namespaces);
  if (root.name !== 'office:document') throw new OdtError(`not an OpenDocument text file (root element <${root.name}>)`);
  const mimetype = root.attrs['office:mimetype'];
  if (mimetype && mimetype !== MIME_TEXT && mimetype !== MIME_TEXT_TEMPLATE) throw new OdtError(`not an OpenDocument text document (${mimetype})`);
  checkBody(root);
  // Re-wrap meta and settings as the standalone parts a package would have.
  const wrap = (element: XmlElement | undefined, rootName: string) =>
    element ? `<?xml version="1.0" encoding="UTF-8"?>\n${fragment({ name: rootName, attrs: { ...ROOT_NS, 'office:version': root.attrs['office:version'] ?? '1.3' }, children: [element] })}` : undefined;
  return {
    content: root,
    styles: root,
    meta: wrap(firstChild(root, 'office:meta'), 'office:document-meta'),
    settings: wrap(firstChild(root, 'office:settings'), 'office:document-settings'),
    files: new Map(),
    mediaTypes: new Map(),
    namespaces,
  };
}

/** Declarations for the standalone meta and settings parts made from a flat file. */
const ROOT_NS: Record<string, string> = Object.fromEntries(
  ['office', 'meta', 'dc', 'xlink', 'ooo'].map((prefix) => [`xmlns:${prefix}`, ODF_NS[prefix]]).concat([['xmlns:config', CONFIG_NS]]),
);

function checkBody(root: XmlElement): void {
  const body = firstChild(root, 'office:body');
  if (!body) throw new OdtError('not an OpenDocument text file: the document has no body');
  if (!firstChild(body, 'office:text')) {
    const other = childElements(body)[0]?.name;
    throw new OdtError(other ? `this is not a text document (its body is <${other}>)` : 'not an OpenDocument text file: the body is empty');
  }
}
