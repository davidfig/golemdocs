// The fonts an SVG file brings with it: `@font-face` rules whose source is a `data:` URI. They are loaded for as long
// as something shows the drawing. Each set of rules gets family names of its own (`golem-svg-3-0`), and painting asks for
// those instead of the names in the file, so two drawings that embed different fonts under one name don't share them,
// nothing else on the page is drawn in them, and the file's own text stays as it is. Fonts at an address are never fetched.

import type { XmlNode } from '@golemdocs/docx';
import type { Scene } from './model.ts';
import { parseFontFaces, type FontFaceRule } from './style.ts';

/** The loaded families, by their name in the file (lower case): the name to draw with. */
export type FontAliases = ReadonlyMap<string, string>;

/** A hold on a drawing's fonts: they stay loaded until it is released. */
export interface SceneFonts {
  readonly aliases: FontAliases;
  release(): void;
}

const NONE: SceneFonts = { aliases: new Map(), release: () => undefined };

/** The `@font-face` rules' stylesheets in a scene, as text (the same text means the same fonts). */
export function fontCss(scene: Scene): string {
  const out: string[] = [];
  const visit = (nodes: readonly XmlNode[]): void => {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      if (node.name === 'style') {
        const text = node.children.filter((c): c is string => typeof c === 'string').join('');
        if (/@font-face/i.test(text)) out.push(text);
      } else visit(node.children);
    }
  };
  visit(scene.defs);
  return out.join('\n');
}

/** The bytes of a `data:` URI; null when it isn't one, or is damaged. */
function dataBytes(uri: string): Uint8Array<ArrayBuffer> | null {
  const m = /^data:([^,]*),/i.exec(uri);
  if (!m) return null;
  try {
    const body = uri.slice(m[0].length).replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Uint8Array.from(/;\s*base64\s*$/i.test(m[1]) ? atob(body.replace(/\s+/g, '')) : body, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The page's fonts, or the worker's; undefined where there are none (tests in Node). */
const fontSet = (): FontFaceSet | undefined => (typeof FontFace === 'undefined' ? undefined : ((typeof document === 'undefined' ? (self as unknown as { fonts?: FontFaceSet }).fonts : document.fonts) ?? undefined));

async function loadFace(family: string, rule: FontFaceRule): Promise<FontFace | null> {
  for (const source of rule.sources) {
    const bytes = dataBytes(source);
    if (!bytes) continue;
    const { weight, style, stretch, unicodeRange } = rule;
    try {
      return await new FontFace(family, bytes, { ...(weight && { weight }), ...(style && { style }), ...(stretch && { stretch }), ...(unicodeRange && { unicodeRange }) }).load();
    } catch {
      // A font the browser can't read: the next source, or the fonts that would do without it.
    }
  }
  return null;
}

interface Loaded {
  holds: number;
  faces: FontFace[];
  ready: Promise<FontAliases>;
}

/** The sets of fonts loaded now, by their rules' text: a drawing shown in two places has its fonts once. */
const loaded = new Map<string, Loaded>();
let nextSet = 0;

async function load(entry: Loaded, css: string): Promise<FontAliases> {
  const set = fontSet()!;
  const rules = parseFontFaces(css);
  const id = nextSet++;
  const names = new Map<string, string>();
  for (const { family } of rules) if (!names.has(family.toLowerCase())) names.set(family.toLowerCase(), `golem-svg-${id}-${names.size}`);
  const aliases = new Map<string, string>();
  await Promise.all(
    rules.map(async (rule) => {
      const name = names.get(rule.family.toLowerCase())!;
      const face = await loadFace(name, rule);
      if (!face) return;
      entry.faces.push(face);
      set.add(face);
      aliases.set(rule.family.toLowerCase(), name);
    }),
  );
  return aliases;
}

/** Loads the fonts a drawing embeds, held until `release` is called. Never rejects: a font that can't be read is left out. */
export async function loadFonts(scene: Scene): Promise<SceneFonts> {
  const css = fontCss(scene);
  if (!css || !fontSet()) return NONE;
  let entry = loaded.get(css);
  if (!entry) {
    const made: Loaded = { holds: 0, faces: [], ready: Promise.resolve(new Map()) };
    loaded.set(css, (entry = made));
    made.ready = load(made, css);
  }
  const held = entry;
  held.holds++;
  const aliases = await held.ready;
  let released = false;
  return {
    aliases,
    release: () => {
      if (released) return;
      released = true;
      if (--held.holds) return;
      for (const face of held.faces) fontSet()?.delete(face);
      loaded.delete(css);
    },
  };
}

/** A `font-family` list with the drawing's own families under the names they were loaded with. */
export function aliasedFamily(family: string, aliases: FontAliases | undefined): string {
  if (!aliases?.size) return family;
  return family.replace(/"([^"]*)"|'([^']*)'|[^,"']+/g, (part, double: string | undefined, single: string | undefined) => {
    const alias = aliases.get((double ?? single ?? part).trim().replace(/\s+/g, ' ').toLowerCase());
    return alias ? `"${alias}"` : part;
  });
}
