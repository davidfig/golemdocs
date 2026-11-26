// An HTML page as the frame shows it (docs/html-pages.md): what a page asks for in its metas, the Content-Security-Policy that
// fits its trust, its relative files inlined from the vault, its `<golem-embed>` elements filled, and the small runtime that
// gives it `golem` and hands its links to the app, all put in front of the page's own HTML. Pure text in, text out: no DOM,
// so it runs in Node tests too.

/** Whether a page is the person's own or came from elsewhere (docs/html-pages.md §1). */
export type PageTrust = 'own' | 'foreign';

/** What a page is allowed, as the frame enforces it. */
export interface PagePolicy {
  /**
   * Its own scripts run: an own page, or a foreign one not allowed to read. A foreign page that may read is shown with none,
   * since a page that runs code can always send what it read away by navigating its own frame, which no policy stops.
   */
  scripts: boolean;
  /** It may load and connect over the network: an own page, or a foreign one not allowed to read. */
  network: boolean;
  /** Hosts it may connect to (`fetch`, sockets), from its `golem-network` meta; only with `network`. */
  connect: readonly string[];
  /**
   * It may post forms (to https addresses, with `network`): an own page only. A page from elsewhere, or one shared with someone, could
   * otherwise draw a sign-in form under the app's address and post what is typed anywhere.
   */
  forms: boolean;
}

/** What a page asks for in its metas. */
export interface PageAsks {
  /** Folders it reads (`golem-reads`), as vault paths with no slashes at the ends; '' for the whole vault. */
  reads: string[];
  /** Hosts it connects to (`golem-network`). */
  network: string[];
}

export { isPageHtml } from './detect.ts';

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The attributes of a tag's text (what follows its name), lower-case names, entities in values decoded. */
export function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A folder as a page names it (`Books/`, `/Books`), as a vault path with no slashes at the ends; '' for the whole vault. */
const folderOf = (folder: string): string => folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/** A host a page names (`api.example.com`, or a URL of it), lower case; null when it is not one. */
export function hostName(site: string): string | null {
  const s = site.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/.*$/, '');
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) ? s : null;
}

/** What a page asks for, from its `<meta name="golem-reads">` and `<meta name="golem-network">` (a list split by commas). */
export function pageAsks(html: string): PageAsks {
  const reads: string[] = [];
  const network: string[] = [];
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = attributes(m[1]);
    const list = (a.content ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (a.name === 'golem-reads') reads.push(...list.map(folderOf));
    else if (a.name === 'golem-network') network.push(...list.map(hostName).filter((h): h is string => h !== null));
  }
  return { reads: [...new Set(reads)], network: [...new Set(network)] };
}

/**
 * The policy for a page: an own page, or a foreign one that may read nothing, runs its scripts and has the network; a foreign
 * one that may read has neither, and shows only what the app filled its embeds with.
 */
export function policyFor(trust: PageTrust, mayRead: boolean, asks: PageAsks): PagePolicy {
  const open = trust === 'own' || !mayRead;
  return { scripts: open, network: open, connect: open ? asks.network : [], forms: trust === 'own' };
}

/**
 * The Content-Security-Policy the frame's page starts with. A page's own policy can only narrow it. With the network, scripts,
 * styles, pictures, fonts and media may come from any https address (agents' pages load libraries from CDNs) and only the
 * named hosts may be connected to; without it, nothing is loaded from anywhere but the page itself and its inlined files.
 */
export function pageCsp(policy: PagePolicy): string {
  const web = policy.network ? ' https:' : '';
  const connect = policy.network && policy.connect.length ? policy.connect.map((h) => `https://${h}`).join(' ') : "'none'";
  return [
    "default-src 'none'",
    policy.scripts ? `script-src 'unsafe-inline' 'unsafe-eval' data: blob:${web}` : "script-src 'none'",
    `style-src 'unsafe-inline' data:${web}`,
    `img-src data: blob:${web}`,
    `font-src data:${web}`,
    `media-src data: blob:${web}`,
    `connect-src ${connect}`,
    'worker-src data: blob:',
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${policy.network && policy.forms ? 'https:' : "'none'"}`,
  ].join('; ');
}

// --- Relative files ---------------------------------------------------------------------------------

/** A file the page names relative to itself, read from the vault: its bytes and type; null when there is none (or it may not). */
export type PageFileReader = (path: string) => Promise<{ bytes: Uint8Array; type: string } | null>;

/** An address that names a file beside the page: not a URL with a scheme, not `//host`, not a fragment, not empty. */
export const isRelative = (address: string): boolean => {
  const a = address.trim();
  return a !== '' && !a.startsWith('#') && !a.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(a);
};

/**
 * A relative address resolved against a folder, as a vault path; null when it climbs above the top of the vault, or above
 * `floor` (a foreign page reaches nothing outside its own folder). The query and fragment are dropped, escapes decoded.
 */
export function resolvePath(folder: string, address: string, floor: string | null = null): string | null {
  let a = address.trim().replace(/[?#].*$/, '');
  try {
    a = decodeURIComponent(a);
  } catch {
    /* kept as written */
  }
  const parts = a.startsWith('/') ? [] : folder.split('/').filter(Boolean);
  for (const part of a.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  const path = parts.join('/');
  if (!path) return null;
  if (floor !== null && floor !== '' && path !== floor && !path.startsWith(`${floor}/`)) return null;
  return path;
}

const TYPES: Record<string, string> = {
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
};

/** A file's type from its name. */
export const typeOf = (path: string): string => TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const dataUrl = (bytes: Uint8Array, type: string): string => `data:${type};base64,${base64(bytes)}`;

/** The most a page's inlined files may add up to. */
export const MAX_INLINED_BYTES = 64 * 1024 * 1024;

/** Elements and the attribute of each that names a file to inline. Links (`<a href>`) are not files: the runtime opens them. */
const FILE_ATTRS: Record<string, string[]> = {
  img: ['src'],
  script: ['src'],
  link: ['href'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  input: ['src'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
};

interface Inliner {
  read: PageFileReader;
  /** The folder relative addresses start from, and the folder nothing may leave (a foreign page's), or null. */
  floor: string | null;
  /** Bytes inlined so far, against MAX_INLINED_BYTES. */
  total: number;
  /** Files read (for the page's dependencies). */
  read_: Set<string>;
}

async function inlineFile(address: string, folder: string, inliner: Inliner, depth: number): Promise<string | null> {
  if (!isRelative(address)) return null;
  const path = resolvePath(folder, address, inliner.floor);
  if (!path) return null;
  const file = await inliner.read(path).catch(() => null);
  if (!file) return null;
  inliner.read_.add(path);
  inliner.total += file.bytes.length;
  if (inliner.total > MAX_INLINED_BYTES) return null;
  // A stylesheet's own files are relative to it.
  if (file.type === 'text/css' && depth < 3) {
    const css = await inlineCss(new TextDecoder().decode(file.bytes), path.split('/').slice(0, -1).join('/'), inliner, depth + 1);
    return dataUrl(new TextEncoder().encode(css), 'text/css');
  }
  return dataUrl(file.bytes, file.type);
}

async function replaceAsync(text: string, pattern: RegExp, replace: (m: RegExpMatchArray) => Promise<string>): Promise<string> {
  const parts: string[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    parts.push(text.slice(at, m.index), await replace(m));
    at = m.index! + m[0].length;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

/** CSS with its relative `url()` and `@import` files inlined. */
async function inlineCss(css: string, folder: string, inliner: Inliner, depth: number): Promise<string> {
  const urls = await replaceAsync(css, /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, async (m) => {
    const inlined = await inlineFile(decodeEntities(m[2]), folder, inliner, depth);
    return inlined ? `url("${inlined}")` : m[0];
  });
  return replaceAsync(urls, /@import\s+(["'])([^"']+)\1/gi, async (m) => {
    const inlined = await inlineFile(m[2], folder, inliner, depth);
    return inlined ? `@import url("${inlined}")` : m[0];
  });
}

/**
 * The page with every file it names relative to itself (pictures, scripts, stylesheets, fonts, media) read from the vault and
 * put in as `data:` addresses, since a frame with no origin of its own can fetch nothing from the vault. `folder` is the page's
 * folder; `floor` the folder nothing may come from outside of (a foreign page's own), or null for the whole vault.
 */
export async function inlineFiles(html: string, folder: string, read: PageFileReader, floor: string | null): Promise<{ html: string; files: string[] }> {
  const inliner: Inliner = { read, floor, total: 0, read_: new Set() };
  // Inside <script> and <style>, text is not markup: those are done on their own, and their scripts left as written.
  let out = await replaceAsync(html, /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<([a-z][a-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, async (m) => {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      if (tag === 'style') return `<style${m[2]}>${await inlineCss(m[3], folder, inliner, 0)}</style>`;
      const a = attributes(m[2]);
      if (a.src === undefined) return m[0];
      const inlined = await inlineFile(a.src, folder, inliner, 0);
      return inlined ? `<script${replaceAttr(m[2], 'src', inlined)}>${m[3]}</script>` : m[0];
    }
    const tag = m[4].toLowerCase();
    let rest = m[5];
    const a = attributes(rest);
    for (const name of FILE_ATTRS[tag] ?? []) {
      if (a[name] === undefined) continue;
      // A <link> is inlined when it is a file the page uses (a stylesheet, an icon, a font), not a link to another page.
      if (tag === 'link' && !/\b(stylesheet|icon|preload|modulepreload|manifest)\b/i.test(a.rel ?? '')) continue;
      const inlined = await inlineFile(a[name], folder, inliner, 0);
      if (inlined) rest = replaceAttr(rest, name, inlined);
    }
    if (a.style !== undefined && /url\(/i.test(a.style)) rest = replaceAttr(rest, 'style', await inlineCss(a.style, folder, inliner, 0));
    return `<${m[4]}${rest}>`;
  });
  if (inliner.total > MAX_INLINED_BYTES) out = html;
  return { html: out, files: [...inliner.read_] };
}

/** A tag's attribute text with one attribute's value replaced (quoted again). */
function replaceAttr(text: string, name: string, value: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(\\s${escaped}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"'=<>\`]+)`, 'i'), (_w, lead: string) => `${lead}"${escapeHtml(value)}"`);
}

// --- Embeds -----------------------------------------------------------------------------------------

/** The addresses of a page's `<golem-embed src="…">` elements, in order, each once. */
export function embedAddresses(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<golem-embed\b([^>]*)>/gi)) {
    const src = attributes(m[1]).src?.trim();
    if (src && !out.includes(src)) out.push(src);
  }
  return out;
}

/** The page with each `<golem-embed>` holding what its address shows (HTML by address); one with none is left as written. */
export function fillEmbeds(html: string, filled: ReadonlyMap<string, string>): string {
  return html.replace(/<golem-embed\b([^>]*)>([\s\S]*?)<\/golem-embed\s*>/gi, (whole, attrs: string) => {
    const src = attributes(attrs).src?.trim();
    const content = src ? filled.get(src) : undefined;
    return content === undefined ? whole : `<golem-embed${attrs}>${content}</golem-embed>`;
  });
}

// --- The runtime ------------------------------------------------------------------------------------

/** What the frame's runtime is told when it starts. */
export interface RuntimeStart {
  /** The page's vault path. */
  path: string;
  trust: PageTrust;
  /** Where it was scrolled to (a reload keeps the place). */
  scroll: number;
  /**
   * This load's secret: every message the runtime sends carries it, and the app answers nothing without it, so a document the frame
   * moves on to (a form posted elsewhere, a script setting `location`) can't ask for anything in the page's name.
   */
  token: string;
}

/** A new secret for one load of a page's frame. */
export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A message from a page's frame, as its runtime sends them. */
export interface FrameMessage {
  golem: 1;
  type: string;
  token: string;
  id?: number;
  op?: string;
  args?: unknown[];
  href?: string;
  y?: number;
}

/** A message from the frame, if it is shaped like the runtime's and carries this load's secret; null for anything else. */
export function frameMessage(data: unknown, token: string | null): FrameMessage | null {
  if (!token || !data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  return m.golem === 1 && typeof m.type === 'string' && m.token === token ? (m as unknown as FrameMessage) : null;
}

/**
 * The script that runs before the page's own: `golem` (each call a message the app answers, and checks), links handed to the
 * app, embeds filled again when what they show changes, and the scroll position reported so a reload keeps it. The app checks
 * every message's source and every request against the page's grant: nothing here is trusted, and the page may change it.
 */
export function runtimeSource(start: RuntimeStart): string {
  return `(() => {
const START = ${JSON.stringify(start).replace(/</g, '\\u003c')};
const post = (m) => parent.postMessage(Object.assign({}, m, { golem: 1, token: START.token }), '*');
const pending = new Map();
const listeners = new Set();
let next = 1;
const call = (op, args) => new Promise((resolve, reject) => {
  const id = next++;
  pending.set(id, { resolve, reject });
  post({ type: 'request', id, op, args: JSON.parse(JSON.stringify(args)) });
});
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (!m || m.golem !== 1 || m.token !== START.token) return;
  if (m.type === 'reply') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
  } else if (m.type === 'embeds') {
    for (const el of document.querySelectorAll('golem-embed')) {
      const src = (el.getAttribute('src') || '').trim();
      if (Object.prototype.hasOwnProperty.call(m.filled, src)) el.innerHTML = m.filled[src];
    }
  } else if (m.type === 'changed') {
    for (const fn of listeners) { try { fn(m.detail); } catch (err) { console.error(err); } }
  }
});
const edits = (path, ops, create) => call('edit', [path, ops, !!create]);
window.golem = Object.freeze({
  path: START.path,
  trust: START.trust,
  read: (path) => call('read', [path]),
  notes: (folder) => call('notes', [folder]),
  sheet: (address) => call('sheet', [address]),
  result: (script) => call('result', [script]),
  embed: (address) => call('embed', [address]),
  open: (path) => post({ type: 'navigate', href: String(path) }),
  on: (event, fn) => { if (event === 'change' && typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); },
  append: (path, markdown, options) => edits(path, [{ op: 'append', markdown: String(markdown) }], options && options.create),
  prepend: (path, markdown) => edits(path, [{ op: 'prepend', markdown: String(markdown) }]),
  replace: (path, markdown, options) => edits(path, [{ op: 'replace', markdown: String(markdown) }], options && options.create),
  appendToSection: (path, heading, markdown) => edits(path, [{ op: 'appendToSection', heading: String(heading), markdown: String(markdown) }]),
  replaceSection: (path, heading, markdown) => edits(path, [{ op: 'replaceSection', heading: String(heading), markdown: String(markdown) }]),
  setField: (path, key, value) => edits(path, [{ op: 'setField', key: String(key), value: value === null ? null : String(value) }]),
});
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href.startsWith('#')) return;
  e.preventDefault();
  post({ type: 'navigate', href });
}, true);
let scrollTimer = 0;
addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => post({ type: 'scroll', y: scrollY }), 150);
}, { passive: true });
addEventListener('keydown', (e) => { if (e.key === 'Escape') post({ type: 'escape' }); });
addEventListener('pagehide', () => post({ type: 'leaving' }));
if (START.scroll) addEventListener('load', () => scrollTo(0, START.scroll));
})();`;
}

const STYLE = 'golem-embed{display:block}golem-embed[inline]{display:inline}golem-embed .golem-embed-error{color:#b3261e;font:0.9em system-ui,sans-serif}golem-embed table{border-collapse:collapse}golem-embed td,golem-embed th{border:1px solid #bfbfbf;padding:2px 6px}golem-embed img{max-width:100%;height:auto}';

/**
 * The frame's whole page: the policy and the runtime first (before anything of the page's own can run or load), then the page;
 * `start` is null for a page whose scripts don't run. A doctype stays first, so the page renders in the mode it was written for.
 */
export function composePage(html: string, csp: string, start: RuntimeStart | null): string {
  // A page never moves itself on (`<meta http-equiv="refresh">`): with no scripts, that would be its one way to send what it shows.
  const page = html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b[^>]*>/gi, '');
  const lead = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(page);
  const runtime = start ? `<script data-golem>${runtimeSource(start)}</script>` : '';
  const head = `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><style data-golem>${STYLE}</style>${runtime}`;
  return lead ? `${lead[0]}${head}${page.slice(lead[0].length)}` : `${head}${page}`;
}
