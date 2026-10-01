// Structural checks on a written ODT: the package rules (mimetype first and stored, manifest
// complete), well-formed parts, declared namespace prefixes, resolvable style references and
// unique ids. Returns the parsed parts for further assertions.

import assert from 'node:assert/strict';
import { parseXml, ZipArchive, type XmlElement } from '@golemdocs/docx';

export interface Parts {
  files: Map<string, Uint8Array>;
  text: Map<string, string>;
  content: XmlElement;
  styles: XmlElement;
  manifest: XmlElement;
}

const MIME = 'application/vnd.oasis.opendocument.text';

export function* walk(root: XmlElement): Generator<XmlElement> {
  const stack = [root];
  while (stack.length) {
    const e = stack.pop()!;
    yield e;
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i];
      if (typeof c !== 'string') stack.push(c);
    }
  }
}

export const find = (root: XmlElement, name: string) => [...walk(root)].filter((e) => e.name === name);

export function textOf(e: XmlElement): string {
  return e.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

export async function validateOdt(bytes: Uint8Array): Promise<Parts> {
  // The first local header must be an uncompressed "mimetype" holding the media type, with no
  // extra field, so the type can be read at a fixed offset.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50, 'starts with a local file header');
  assert.equal(view.getUint16(8, true), 0, 'mimetype is stored, not deflated');
  const nameLength = view.getUint16(26, true);
  assert.equal(view.getUint16(28, true), 0, 'mimetype has no extra field');
  assert.equal(new TextDecoder().decode(bytes.subarray(30, 30 + nameLength)), 'mimetype');
  assert.equal(new TextDecoder().decode(bytes.subarray(30 + nameLength, 30 + nameLength + MIME.length)), MIME);

  const zip = ZipArchive.read(bytes);
  const files = new Map<string, Uint8Array>();
  const text = new Map<string, string>();
  for (const [name, entry] of zip.entries) {
    files.set(name, await entry.read());
    if (name.endsWith('.xml')) text.set(name, await entry.text());
  }
  assert.equal([...zip.entries.keys()][0], 'mimetype');
  for (const part of ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml']) assert.ok(files.has(part), `${part} present`);

  const parsed = new Map<string, XmlElement>();
  for (const [name, source] of text) {
    assert.doesNotThrow(() => parsed.set(name, parseXml(source)), `${name} is well-formed`);
    assert.match(source, /^<\?xml version="1.0" encoding="UTF-8"/, `${name} has an XML declaration`);
  }

  // Manifest: the root entry, every file in the package, nothing that isn't there.
  const manifest = parsed.get('META-INF/manifest.xml')!;
  assert.equal(manifest.name, 'manifest:manifest');
  assert.equal(manifest.attrs['manifest:version'], '1.3');
  const listed = new Map<string, string>();
  for (const e of manifest.children) if (typeof e !== 'string') listed.set(e.attrs['manifest:full-path'], e.attrs['manifest:media-type']);
  assert.equal(listed.get('/'), MIME);
  for (const name of files.keys()) {
    if (name === 'mimetype' || name === 'META-INF/manifest.xml') continue;
    assert.ok(listed.has(name), `manifest lists ${name}`);
  }
  for (const path of listed.keys()) {
    if (path === '/' || path.endsWith('/')) continue;
    assert.ok(files.has(path), `manifest entry ${path} exists`);
  }

  // Every prefix used is declared on the root.
  for (const [name, root] of parsed) {
    const used = new Set<string>();
    for (const e of walk(root)) {
      for (const n of [e.name, ...Object.keys(e.attrs)]) {
        const colon = n.indexOf(':');
        if (colon > 0 && !n.startsWith('xmlns')) used.add(n.slice(0, colon));
      }
    }
    used.delete('xml');
    for (const prefix of used) assert.ok(root.attrs[`xmlns:${prefix}`], `${name} declares xmlns:${prefix}`);
  }

  const content = parsed.get('content.xml')!;
  const styles = parsed.get('styles.xml')!;
  assert.equal(content.name, 'office:document-content');
  assert.equal(content.attrs['office:version'], '1.3');
  assert.equal(styles.name, 'office:document-styles');
  assert.equal(parsed.get('meta.xml')!.name, 'office:document-meta');

  // Style references resolve: content can use its own automatic styles and common styles;
  // styles.xml its own automatic styles and common styles.
  const names = (root: XmlElement, section: string) => {
    const out = new Set<string>();
    const container = root.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === section);
    for (const e of container ? walk(container) : []) if (e.attrs['style:name'] && e !== container) out.add(e.attrs['style:name']);
    return out;
  };
  const common = names(styles, 'office:styles');
  const fonts = new Set([...names(content, 'office:font-face-decls'), ...names(styles, 'office:font-face-decls')]);
  const check = (root: XmlElement, known: Set<string>, part: string) => {
    for (const e of walk(root)) {
      for (const [key, value] of Object.entries(e.attrs)) {
        if (key.startsWith('style:font-name')) assert.ok(fonts.has(value), `${part}: font ${value} is declared`);
        else if (key.endsWith('style-name') && key !== 'text:visited-style-name' && key !== 'style:page-layout-name') {
          assert.ok(known.has(value), `${part}: ${e.name} ${key}="${value}" resolves`);
        }
      }
    }
  };
  check(content, new Set([...common, ...names(content, 'office:automatic-styles')]), 'content.xml');
  check(styles, new Set([...common, ...names(styles, 'office:automatic-styles')]), 'styles.xml');
  const layouts = names(styles, 'office:automatic-styles');
  for (const master of find(styles, 'style:master-page')) assert.ok(layouts.has(master.attrs['style:page-layout-name']), 'page layout exists');

  // xml:id values are unique within each part.
  for (const [name, root] of parsed) {
    const ids = [...walk(root)].map((e) => e.attrs['xml:id']).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, `${name}: xml:ids are unique`);
  }
  // Pictures referenced from content exist.
  for (const image of [...find(content, 'draw:image'), ...find(styles, 'draw:image')]) {
    assert.ok(files.has(image.attrs['xlink:href']), `picture ${image.attrs['xlink:href']} is in the package`);
  }
  return { files, text, content, styles, manifest };
}
