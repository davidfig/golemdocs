// SPDX-License-Identifier: MIT
// Open Packaging Conventions: the parts, content types and relationships inside a .docx.
//
// Part names here are ZIP entry names without a leading slash ("word/document.xml").
// Parts that are never replaced are written back byte-for-byte from the original archive.

import { XmlError, el, elements, parseXml, serializeXml, type XmlElement } from '../xml/xml.ts';
import { NS } from '../xml/namespaces.ts';
import { ZipArchive, writeZip, type ZipEntry, type ZipInput } from '../zip/zip.ts';

export const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  fontTable: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
  commentsExtended: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
  coreProperties: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProperties: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
} as const;

export const CONTENT_TYPE = {
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  header: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  footer: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  coreProperties: 'application/vnd.openxmlformats-package.core-properties+xml',
  extendedProperties: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  comments: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
  commentsExtended: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
  relationships: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
} as const;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
  webp: 'image/webp',
};

export function contentTypeForExtension(extension: string): string | undefined {
  return IMAGE_TYPES[extension.toLowerCase()];
}

/**
 * Relationship types are compared by their last path segment so Strict OOXML
 * (purl.oclc.org URIs) and Transitional both match.
 */
export function isRelType(type: string, expected: string): boolean {
  return type === expected || type.slice(type.lastIndexOf('/')) === expected.slice(expected.lastIndexOf('/'));
}

export class PackageError extends Error {}

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** Resolves a relationship target against the part that owns it. */
export function resolveTarget(sourcePart: string, target: string): string {
  let path = target;
  try {
    path = decodeURIComponent(target);
  } catch {
    // Leave malformed escapes as-is.
  }
  const base = path.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') base.pop();
    else base.push(segment);
  }
  return base.join('/');
}

/** A target for `part` written relative to `sourcePart`, as Word does ("media/image1.png"). */
function relativeTarget(sourcePart: string, part: string): string {
  const from = sourcePart.split('/').slice(0, -1);
  const to = part.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...Array(from.length - common).fill('..'), ...to.slice(common)].join('/');
}

export class Relationships {
  private dirty = false;

  constructor(
    /** The part these relationships belong to ("" for the package itself). */
    readonly source: string,
    readonly list: Relationship[],
  ) {}

  get modified(): boolean {
    return this.dirty;
  }

  byId(id: string): Relationship | undefined {
    return this.list.find((r) => r.id === id);
  }

  byType(type: string): Relationship[] {
    return this.list.filter((r) => isRelType(r.type, type));
  }

  /** Absolute part name for an internal relationship. */
  partName(rel: Relationship): string {
    return resolveTarget(this.source, rel.target);
  }

  /** Adds a relationship to an internal part (or an external URL) and returns its id. */
  add(type: string, target: string, external = false): string {
    // isRelType: a Strict document's relationship to the part counts, rather than getting a duplicate.
    const existing = this.list.find(
      (r) => isRelType(r.type, type) && r.external === external && (external ? r.target === target : this.partName(r) === target),
    );
    if (existing) return existing.id;
    const used = new Set(this.list.map((r) => r.id));
    let n = this.list.length + 1;
    while (used.has(`rId${n}`)) n++;
    const id = `rId${n}`;
    this.list.push({ id, type, target: external ? target : relativeTarget(this.source, target), external });
    this.dirty = true;
    return id;
  }

  remove(id: string): void {
    const index = this.list.findIndex((r) => r.id === id);
    if (index >= 0) {
      this.list.splice(index, 1);
      this.dirty = true;
    }
  }

  static parse(source: string, root: XmlElement): Relationships {
    const list: Relationship[] = [];
    for (const rel of elements(root)) {
      // Without an id or a target nothing can use it (and it would break lookups by id).
      if (rel.name !== 'Relationship' || !rel.attrs.Id || rel.attrs.Target === undefined) continue;
      list.push({
        id: rel.attrs.Id,
        type: rel.attrs.Type ?? '',
        target: rel.attrs.Target,
        external: rel.attrs.TargetMode === 'External',
      });
    }
    return new Relationships(source, list);
  }

  toXml(): XmlElement {
    return el(
      'Relationships',
      { xmlns: NS.rel },
      this.list.map((r) =>
        el('Relationship', { Id: r.id, Type: r.type, Target: r.target, TargetMode: r.external ? 'External' : undefined }),
      ),
    );
  }
}

/** The ZIP entry holding a part's relationships. */
export function relationshipsPartName(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

interface Part {
  /** Original bytes, copied through untouched unless replaced. */
  entry?: ZipEntry;
  /** Replacement contents. */
  data?: Uint8Array;
}

export class OpcPackage {
  /** Parts in archive order. Relationship parts and [Content_Types].xml are managed separately. */
  private readonly parts = new Map<string, Part>();
  private readonly lowerCaseNames = new Map<string, string>();
  private readonly defaults = new Map<string, string>();
  private readonly overrides = new Map<string, string>();
  private readonly rels = new Map<string, Relationships>();
  private readonly relsEntries = new Map<string, ZipEntry>();

  static async read(bytes: Uint8Array): Promise<OpcPackage> {
    const zip = ZipArchive.read(bytes);
    const pkg = new OpcPackage();
    const types = zip.entries.get('[Content_Types].xml');
    if (!types) throw new PackageError('not an Office document: [Content_Types].xml is missing');
    let typesRoot: XmlElement;
    try {
      typesRoot = parseXml(await types.text());
    } catch (e) {
      if (e instanceof XmlError) throw new PackageError(`[Content_Types].xml: ${e.message}`);
      throw e;
    }
    for (const item of elements(typesRoot)) {
      const { Extension: extension, PartName: partName, ContentType: contentType } = item.attrs;
      if (contentType === undefined) continue;
      if (item.name === 'Default' && extension !== undefined) pkg.defaults.set(extension.toLowerCase(), contentType);
      else if (item.name === 'Override' && partName !== undefined) pkg.overrides.set(partName.replace(/^\//, '').toLowerCase(), contentType);
    }
    for (const [name, entry] of zip.entries) {
      if (name === '[Content_Types].xml') continue;
      if (/(^|\/)_rels\/[^/]*\.rels$/.test(name)) {
        pkg.relsEntries.set(name, entry);
        continue;
      }
      pkg.parts.set(name, { entry });
      pkg.lowerCaseNames.set(name.toLowerCase(), name);
    }
    return pkg;
  }

  /** An empty package, for building a document from scratch. */
  static create(): OpcPackage {
    const pkg = new OpcPackage();
    pkg.defaults.set('rels', CONTENT_TYPE.relationships);
    pkg.defaults.set('xml', CONTENT_TYPE.xml);
    return pkg;
  }

  /** The actual name of a part, matching case-insensitively as OPC requires. */
  resolveName(name: string): string | undefined {
    return this.parts.has(name) ? name : this.lowerCaseNames.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.resolveName(name) !== undefined;
  }

  get partNames(): string[] {
    return [...this.parts.keys()];
  }

  contentType(name: string): string | undefined {
    const override = this.overrides.get(name.toLowerCase());
    if (override) return override;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? this.defaults.get(name.slice(dot + 1).toLowerCase()) : undefined;
  }

  async bytes(name: string): Promise<Uint8Array> {
    const actual = this.resolveName(name);
    const part = actual === undefined ? undefined : this.parts.get(actual);
    if (!part) throw new PackageError(`missing part ${name}`);
    if (part.data) return part.data;
    return part.entry!.read();
  }

  async text(name: string): Promise<string> {
    return new TextDecoder().decode(await this.bytes(name));
  }

  async xml(name: string): Promise<XmlElement> {
    try {
      return parseXml(await this.text(name));
    } catch (e) {
      if (e instanceof XmlError) throw new PackageError(`${name}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Adds or replaces a part. An explicit content type override already on the part wins, so a
   * replaced part keeps its original type (e.g. a macro-enabled or template main part).
   */
  set(name: string, data: Uint8Array | string | XmlElement, contentType?: string): void {
    const bytes =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
          ? data
          : new TextEncoder().encode(serializeXml(data));
    const actual = this.resolveName(name) ?? name;
    this.parts.set(actual, { data: bytes });
    this.lowerCaseNames.set(actual.toLowerCase(), actual);
    const lower = actual.toLowerCase();
    if (contentType && !this.overrides.has(lower) && this.contentType(actual) !== contentType) {
      this.overrides.set(lower, contentType);
    }
  }

  /** Registers a default content type for an extension (used for media). */
  setDefaultContentType(extension: string, contentType: string): void {
    if (!this.defaults.has(extension.toLowerCase())) this.defaults.set(extension.toLowerCase(), contentType);
  }

  delete(name: string): void {
    const actual = this.resolveName(name);
    if (actual === undefined) return;
    this.parts.delete(actual);
    this.lowerCaseNames.delete(actual.toLowerCase());
    this.overrides.delete(actual.toLowerCase());
    this.rels.delete(actual);
    this.relsEntries.delete(relationshipsPartName(actual));
  }

  /** Relationships owned by a part ("" for the package's own). Parsed once, on demand. */
  async relationships(part: string): Promise<Relationships> {
    let rels = this.rels.get(part);
    if (!rels) {
      const relsName = part === '' ? '_rels/.rels' : relationshipsPartName(part);
      const entry = this.relsEntries.get(relsName);
      rels = entry ? Relationships.parse(part, parseXml(await entry.text())) : new Relationships(part, []);
      this.rels.set(part, rels);
    }
    return rels;
  }

  /** A part name not yet used, e.g. uniqueName('word/media/image', 'png') -> word/media/image3.png. */
  uniqueName(prefix: string, extension: string): string {
    for (let n = 1; ; n++) {
      const name = `${prefix}${n}.${extension}`;
      if (!this.has(name)) return name;
    }
  }

  async write(): Promise<Uint8Array> {
    const inputs: ZipInput[] = [];
    const types = el('Types', { xmlns: NS.ct }, [
      ...[...this.defaults].map(([ext, type]) => el('Default', { Extension: ext, ContentType: type })),
      ...[...this.overrides]
        .filter(([name]) => this.lowerCaseNames.has(name))
        .map(([name, type]) => el('Override', { PartName: `/${this.lowerCaseNames.get(name)}`, ContentType: type })),
    ]);
    inputs.push({ name: '[Content_Types].xml', data: new TextEncoder().encode(serializeXml(types)) });

    // Relationship parts: regenerated if modified, otherwise copied.
    const relsWritten = new Set<string>();
    const addRels = (part: string) => {
      const relsName = part === '' ? '_rels/.rels' : relationshipsPartName(part);
      if (relsWritten.has(relsName)) return;
      const rels = this.rels.get(part);
      if (rels && (rels.modified || !this.relsEntries.has(relsName))) {
        if (rels.list.length) inputs.push({ name: relsName, data: new TextEncoder().encode(serializeXml(rels.toXml())) });
      } else {
        const entry = this.relsEntries.get(relsName);
        if (entry) inputs.push({ name: relsName, entry });
      }
      relsWritten.add(relsName);
    };
    addRels('');
    for (const [name, part] of this.parts) {
      inputs.push(part.data ? { name, data: part.data, compress: !isCompressedMedia(name) } : { name, entry: part.entry! });
      addRels(name);
    }
    return writeZip(inputs);
  }
}

function isCompressedMedia(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}
