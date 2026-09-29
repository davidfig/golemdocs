// Markdown <-> document model, hand-rolled (CommonMark-ish plus GFM tables and strikethrough).
//
// Conventions in the model (what the integrator and the editor should know):
//  - Headings: paragraph styles Heading1..Heading6; blockquotes: paragraph style "Quote" (nesting
//    depth > 1 adds 720 twips of direct left indent per level); code blocks: one paragraph per
//    line in the "Code" paragraph style (monospace, shaded); horizontal rule: an empty paragraph
//    with a bottom border.
//  - Inline code: character style "InlineCode" plus a direct Courier New font. Export also treats
//    any run in a monospace font as code.
//  - Lists: real numbering. Every Markdown list gets its own abstract numbering + instance (so
//    numbers restart), 9 levels all of one kind (bullet or decimal/lowerLetter/lowerRoman); an
//    item is a paragraph in "ListParagraph" style with numbering { id, level = nesting depth }.
//    Further paragraphs inside an item are un-numbered ListParagraph paragraphs.
//  - Links: Hyperlink inlines whose runs use the "Hyperlink" character style. Images cannot be
//    embedded without bytes, so `![alt](url)` becomes a Hyperlink to `url` whose run (character
//    style "ImagePlaceholder") reads "[Image: alt]"; export turns it back into an image.
//  - Tables: Table with style TableGrid; the first row is a header row (row.properties.header),
//    column alignment is the paragraph justification of the cells.
//  - Footnotes ([^1] and definitions), task-list boxes and raw HTML are kept as literal text: the
//    model has no footnote part to attach them to.
//
// Nothing here throws on odd input: unknown syntax degrades to literal text.

import { StyleResolver, WordDocument } from '@word/docx';
import type {
  Block,
  Hyperlink,
  Inline,
  NumberingLevel,
  NumberingReference,
  Paragraph,
  ParagraphProperties,
  Run,
  RunContent,
  RunProperties,
  Style,
  Table,
  TableCell,
  TableRow,
} from '@word/docx';

const MAX_DEPTH = 24;
const MONO = 'Courier New';
const MONO_FONTS = { ascii: MONO, hAnsi: MONO, eastAsia: MONO, cs: MONO };
const PAGE_TEXT_WIDTH = 9360;

// --- Model helpers -------------------------------------------------------------------------------

const newParagraph = (properties: ParagraphProperties, children: Inline[] = []): Paragraph => ({
  kind: 'paragraph',
  properties,
  children,
  attrs: {},
});

const newRun = (properties: RunProperties, content: RunContent[]): Run => ({ kind: 'run', properties, content, attrs: {} });

/** Appends text to run content; tabs become tab items. */
function appendText(content: RunContent[], text: string): void {
  let start = 0;
  for (;;) {
    const tab = text.indexOf('\t', start);
    const part = tab < 0 ? text.slice(start) : text.slice(start, tab);
    if (part) {
      const last = content[content.length - 1];
      if (last && last.kind === 'text') last.text += part;
      else content.push({ kind: 'text', text: part });
    }
    if (tab < 0) return;
    content.push({ kind: 'tab' });
    start = tab + 1;
  }
}

/** Definitions of the styles Markdown documents use (headings, quotes, code, lists…), by id. */
export function styleFor(id: string): Style | undefined {
  const heading = /^Heading([1-6])$/.exec(id);
  if (heading) {
    const level = Number(heading[1]);
    const size = [32, 26, 24, 22, 22, 22][level - 1];
    return {
      type: 'paragraph',
      id,
      name: `heading ${level}`,
      basedOn: 'Normal',
      next: 'Normal',
      paragraphProperties: {
        keepNext: true,
        keepLines: true,
        spacing: { before: level === 1 ? 240 : 40, after: 0 },
        outlineLevel: level - 1,
      },
      runProperties: {
        fonts: { ascii: 'Calibri Light', hAnsi: 'Calibri Light', eastAsia: 'Calibri Light', cs: 'Times New Roman' },
        color: { val: level === 3 || level === 6 ? '1F3763' : '2F5496' },
        ...(level === 4 ? { italic: true } : {}),
        size,
        sizeCs: size,
      },
      attrs: {},
    };
  }
  switch (id) {
    case 'Quote':
      return {
        type: 'paragraph',
        id,
        name: 'Quote',
        basedOn: 'Normal',
        next: 'Normal',
        paragraphProperties: {
          spacing: { before: 120, after: 120 },
          indent: { left: 720 },
          borders: { left: { val: 'single', sz: 18, space: 8, color: 'BFBFBF' } },
        },
        runProperties: { italic: true, color: { val: '595959' } },
        attrs: {},
      };
    case 'Code':
      return {
        type: 'paragraph',
        id,
        name: 'Code',
        basedOn: 'Normal',
        paragraphProperties: {
          spacing: { before: 0, after: 0, line: 240, lineRule: 'auto' },
          shading: { val: 'clear', color: 'auto', fill: 'F2F2F2' },
        },
        runProperties: { fonts: MONO_FONTS, size: 20, sizeCs: 20 },
        attrs: {},
      };
    case 'InlineCode':
      return {
        type: 'character',
        id,
        name: 'Inline Code',
        basedOn: 'DefaultParagraphFont',
        runProperties: { fonts: MONO_FONTS, shading: { val: 'clear', color: 'auto', fill: 'F2F2F2' } },
        attrs: {},
      };
    case 'ImagePlaceholder':
      return {
        type: 'character',
        id,
        name: 'Image Placeholder',
        basedOn: 'DefaultParagraphFont',
        runProperties: { italic: true, color: { val: '7F7F7F' } },
        attrs: {},
      };
    case 'ListParagraph':
      return {
        type: 'paragraph',
        id,
        name: 'List Paragraph',
        basedOn: 'Normal',
        paragraphProperties: { indent: { left: 720 }, contextualSpacing: true },
        attrs: {},
      };
    case 'Hyperlink':
      return {
        type: 'character',
        id,
        name: 'Hyperlink',
        basedOn: 'DefaultParagraphFont',
        runProperties: { color: { val: '0563C1', themeColor: 'hyperlink' }, underline: { val: 'single' } },
        attrs: {},
      };
    case 'TableGrid':
      return {
        type: 'table',
        id,
        name: 'Table Grid',
        basedOn: 'TableNormal',
        paragraphProperties: { spacing: { after: 0, line: 240, lineRule: 'auto' } },
        tableProperties: {
          borders: Object.fromEntries(
            ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => [side, { val: 'single', sz: 4, space: 0, color: 'auto' }]),
          ),
        },
        attrs: {},
      };
  }
  return undefined;
}

// --- Inline parsing ------------------------------------------------------------------------------

interface INode {
  t: 'text' | 'code' | 'delim' | 'br' | 'image';
  s: string;
  /** Destination when the node is inside a link. */
  link?: string;
  /** Image destination. */
  url?: string;
  /** Emphasis deltas (difference array: the running sum along the node list is the depth). */
  b: number;
  i: number;
  k: number;
}

interface Delim {
  ch: string;
  n: number;
  orig: number;
  open: boolean;
  close: boolean;
  /** Index in the node list (valid while the delimiter is on the stack) and the node itself. */
  node: number;
  ref: INode;
  prev: Delim | null;
  next: Delim | null;
}

interface Bracket {
  node: number;
  image: boolean;
  index: number;
  lastDelim: Delim | null;
  textStart: number;
}

const mk = (t: INode['t'], s = ''): INode => ({ t, s, b: 0, i: 0, k: 0 });
const isPunct = (c: string | undefined): boolean => {
  if (!c) return false;
  const x = c.charCodeAt(0);
  return (x >= 33 && x <= 47) || (x >= 58 && x <= 64) || (x >= 91 && x <= 96) || (x >= 123 && x <= 126);
};
const UNI_WS = /\s/;
const UNI_PUNCT = /[\p{P}\p{S}]/u;

const SPECIAL = /[\\`*_~[\]!<&\n]/g;
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const BR_TAG = /<br\s*\/?>/iy;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y;
const EMAIL =
  /<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·',
  bull: '•', deg: '°', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
};

function decodeEntity(body: string): string | null {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code > 0x10ffff) return null;
    if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  }
  return NAMED_ENTITIES[body] ?? null;
}

/** Backslash escapes and entities in a link destination. */
function unescapeUrl(s: string): string {
  if (!s.includes('\\') && !s.includes('&')) return s;
  return s
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, body: string) => decodeEntity(body) ?? m);
}

const normalizeLabel = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

function skipWs(text: string, p: number): number {
  while (p < text.length && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) p++;
  return p;
}

/** Parses `(dest "title")` starting at the "(" at `q`. Lengths are capped so scans stay linear. */
function linkTail(text: string, q: number): { url: string; end: number } | null {
  const n = text.length;
  let p = skipWs(text, q + 1);
  let url = '';
  if (text[p] === '<') {
    const limit = Math.min(n, p + 2050);
    let e = p + 1;
    while (e < limit && text[e] !== '>' && text[e] !== '\n' && text[e] !== '<') {
      if (text[e] === '\\') e++;
      e++;
    }
    if (text[e] !== '>') return null;
    url = text.slice(p + 1, e);
    p = e + 1;
  } else {
    const limit = Math.min(n, p + 2050);
    let depth = 0;
    let e = p;
    let stopped = false;
    while (e < limit) {
      const ch = text[e];
      if (ch === '\\' && isPunct(text[e + 1])) {
        e += 2;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') {
        stopped = true;
        break;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) {
          stopped = true;
          break;
        }
        depth--;
      }
      e++;
    }
    if (!stopped && e < n) return null;
    if (depth !== 0) return null;
    url = text.slice(p, e);
    p = e;
  }
  const afterDest = p;
  p = skipWs(text, p);
  if (p > afterDest && (text[p] === '"' || text[p] === "'" || text[p] === '(')) {
    const close = text[p] === '(' ? ')' : text[p];
    const limit = Math.min(n, p + 1002);
    let e = p + 1;
    while (e < limit && text[e] !== close) {
      if (text[e] === '\\') e++;
      e++;
    }
    if (text[e] !== close) return null;
    p = skipWs(text, e + 1);
  }
  if (text[p] !== ')') return null;
  return { url: unescapeUrl(url), end: p + 1 };
}

function nodeText(n: INode): string {
  return n.t === 'br' ? ' ' : n.s;
}

/** Inline Markdown to model inlines. Linear-ish: delimiter matching uses the CommonMark stack with per-kind bottoms. */
function parseInline(text: string, refs: Map<string, string>, used: Set<string>): Inline[] {
  const nodes: INode[] = [];
  const brackets: Bracket[] = [];
  const allDelims: Delim[] = [];
  // Delimiter stack ends, in an object so closures and the main loop see the same values.
  const stack: { head: Delim | null; tail: Delim | null } = { head: null, tail: null };
  let parts: string[] = [];
  let barrier = 0;
  const ticks: { map: Map<number, { pos: number[]; ptr: number }> | null } = { map: null };

  const flush = (): void => {
    if (parts.length) {
      const s = parts.length === 1 ? parts[0] : parts.join('');
      if (s) nodes.push(mk('text', s));
      parts = [];
    }
  };

  const removeDelim = (d: Delim): void => {
    if (d.prev) d.prev.next = d.next;
    else stack.head = d.next;
    if (d.next) d.next.prev = d.prev;
    else stack.tail = d.prev;
  };

  const processEmphasis = (bottom: Delim | null): void => {
    const bottoms = new Map<string, Delim | null>();
    let closer: Delim | null = bottom ? bottom.next : stack.head;
    while (closer) {
      if (!closer.close) {
        closer = closer.next;
        continue;
      }
      const key = `${closer.ch}${closer.orig % 3}${closer.open ? 'o' : 'c'}`;
      const stop = (bottoms.has(key) ? bottoms.get(key) : bottom) as Delim | null;
      let opener: Delim | null = closer.prev;
      while (opener && opener !== stop) {
        if (opener.ch === closer.ch && opener.open) {
          if (closer.ch === '~') {
            if (opener.n >= 2 && closer.n >= 2) break;
          } else if (
            !((opener.close || closer.open) && (opener.orig + closer.orig) % 3 === 0 && !(opener.orig % 3 === 0 && closer.orig % 3 === 0))
          ) {
            break;
          }
        }
        opener = opener.prev;
      }
      if (opener && opener !== stop) {
        const use = closer.ch === '~' ? 2 : closer.n >= 2 && opener.n >= 2 ? 2 : 1;
        const field = closer.ch === '~' ? 'k' : use === 2 ? 'b' : 'i';
        nodes[opener.node + 1][field]++;
        nodes[closer.node][field]--;
        opener.n -= use;
        closer.n -= use;
        opener.next = closer;
        closer.prev = opener;
        if (opener.n === 0) removeDelim(opener);
        if (closer.n === 0) {
          const next: Delim | null = closer.next;
          removeDelim(closer);
          closer = next;
        }
      } else {
        bottoms.set(key, closer.prev);
        const next: Delim | null = closer.next;
        if (!closer.open) removeDelim(closer);
        closer = next;
      }
    }
    if (bottom) {
      bottom.next = null;
      stack.tail = bottom;
    } else {
      stack.head = null;
      stack.tail = null;
    }
  };

  const findCodeCloser = (p: number, len: number): number => {
    if (!ticks.map) {
      const map = new Map<number, { pos: number[]; ptr: number }>();
      const re = /`+/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        let entry = map.get(m[0].length);
        if (!entry) map.set(m[0].length, (entry = { pos: [], ptr: 0 }));
        entry.pos.push(m.index);
      }
      ticks.map = map;
    }
    const entry = ticks.map.get(len);
    if (!entry) return -1;
    while (entry.ptr < entry.pos.length && entry.pos[entry.ptr] <= p) entry.ptr++;
    return entry.ptr < entry.pos.length ? entry.pos[entry.ptr] : -1;
  };

  const n = text.length;
  let p = 0;
  while (p < n) {
    SPECIAL.lastIndex = p;
    const m = SPECIAL.exec(text);
    const q = m ? m.index : n;
    if (q > p) parts.push(text.slice(p, q));
    if (q >= n) break;
    p = q;
    const c = text[p];
    switch (c) {
      case '\\': {
        const next = text[p + 1];
        if (next === '\n') {
          flush();
          nodes.push(mk('br'));
          p += 2;
          while (text[p] === ' ' || text[p] === '\t') p++;
        } else if (next !== undefined && isPunct(next)) {
          parts.push(next);
          p += 2;
        } else {
          parts.push('\\');
          p++;
        }
        break;
      }
      case '\n': {
        // Two or more trailing spaces make a hard break; otherwise the line break is a space.
        let spaces = 0;
        while (parts.length) {
          const last = parts[parts.length - 1];
          let e = last.length;
          while (e > 0 && last[e - 1] === ' ') e--;
          spaces += last.length - e;
          if (e === 0) parts.pop();
          else {
            if (e < last.length) parts[parts.length - 1] = last.slice(0, e);
            break;
          }
        }
        if (spaces >= 2) {
          flush();
          nodes.push(mk('br'));
        } else parts.push(' ');
        p++;
        while (text[p] === ' ' || text[p] === '\t') p++;
        break;
      }
      case '`': {
        let e = p;
        while (text[e] === '`') e++;
        const len = e - p;
        const closer = findCodeCloser(p, len);
        if (closer < 0) {
          parts.push(text.slice(p, e));
          p = e;
          break;
        }
        let s = text.slice(e, closer).replace(/\n/g, ' ');
        if (s.length > 2 && s[0] === ' ' && s[s.length - 1] === ' ' && s.trim() !== '') s = s.slice(1, -1);
        flush();
        nodes.push(mk('code', s));
        p = closer + len;
        break;
      }
      case '*':
      case '_':
      case '~': {
        let e = p;
        while (text[e] === c) e++;
        const len = e - p;
        if (c === '~' && len !== 2) {
          parts.push(text.slice(p, e));
          p = e;
          break;
        }
        const before = p > 0 ? text[p - 1] : ' ';
        const after = e < n ? text[e] : ' ';
        const wsBefore = UNI_WS.test(before);
        const wsAfter = UNI_WS.test(after);
        const puBefore = UNI_PUNCT.test(before);
        const puAfter = UNI_PUNCT.test(after);
        const left = !wsAfter && (!puAfter || wsBefore || puBefore);
        const right = !wsBefore && (!puBefore || wsAfter || puAfter);
        const open = c === '_' ? left && (!right || puBefore) : left;
        const close = c === '_' ? right && (!left || puAfter) : right;
        if (!open && !close) {
          parts.push(text.slice(p, e));
        } else {
          flush();
          const ref = mk('delim', text.slice(p, e));
          const d: Delim = { ch: c, n: len, orig: len, open, close, node: nodes.length, ref, prev: stack.tail, next: null };
          if (stack.tail) stack.tail.next = d;
          else stack.head = d;
          stack.tail = d;
          allDelims.push(d);
          nodes.push(ref);
        }
        p = e;
        break;
      }
      case '!': {
        if (text[p + 1] === '[') {
          flush();
          nodes.push(mk('text', '!['));
          brackets.push({ node: nodes.length - 1, image: true, index: brackets.length, lastDelim: stack.tail, textStart: p + 2 });
          p += 2;
        } else {
          parts.push('!');
          p++;
        }
        break;
      }
      case '[': {
        flush();
        nodes.push(mk('text', '['));
        brackets.push({ node: nodes.length - 1, image: false, index: brackets.length, lastDelim: stack.tail, textStart: p + 1 });
        p++;
        break;
      }
      case ']': {
        const opener = brackets.pop();
        if (!opener) {
          parts.push(']');
          p++;
          break;
        }
        // Openers below the barrier were deactivated by an earlier link (links can't nest).
        const inactive = !opener.image && opener.index < barrier;
        if (barrier > brackets.length) barrier = brackets.length;
        if (inactive) {
          parts.push(']');
          p++;
          break;
        }
        let url: string | undefined;
        let end = p + 1;
        if (text[p + 1] === '(') {
          const tailInfo = linkTail(text, p + 1);
          if (tailInfo) {
            url = tailInfo.url;
            end = tailInfo.end;
          }
        }
        if (url === undefined && refs.size) {
          const inner = p - opener.textStart <= 999 ? text.slice(opener.textStart, p) : null;
          let label: string | null = inner;
          let e = p + 1;
          if (text[p + 1] === '[') {
            let r = p + 2;
            const limit = Math.min(n, p + 1002);
            while (r < limit && text[r] !== ']' && text[r] !== '[') {
              if (text[r] === '\\') r++;
              r++;
            }
            if (text[r] === ']') {
              const explicit = text.slice(p + 2, r);
              label = explicit.trim() === '' ? inner : explicit;
              e = r + 1;
            } else label = null;
          }
          if (label !== null && !label.startsWith('^')) {
            const found = refs.get(normalizeLabel(label));
            if (found !== undefined) {
              url = found;
              end = e;
            }
          }
        }
        if (url === undefined) {
          parts.push(']');
          p++;
          break;
        }
        flush();
        processEmphasis(opener.lastDelim);
        if (opener.image) {
          // Delimiters inside the alt text that matched are markup, not text; the rest is literal.
          while (allDelims.length && allDelims[allDelims.length - 1].node > opener.node) {
            const d = allDelims.pop()!;
            d.ref.s = d.ch.repeat(d.n);
          }
          let alt = '';
          for (let i = opener.node + 1; i < nodes.length; i++) alt += nodeText(nodes[i]);
          nodes.length = opener.node;
          const image = mk('image', alt);
          image.url = url;
          nodes.push(image);
        } else {
          nodes[opener.node].s = '';
          for (let i = opener.node + 1; i < nodes.length; i++) nodes[i].link = url;
          barrier = brackets.length;
        }
        p = end;
        break;
      }
      case '<': {
        BR_TAG.lastIndex = p;
        if (BR_TAG.exec(text)) {
          flush();
          nodes.push(mk('br'));
          p = BR_TAG.lastIndex;
          break;
        }
        AUTOLINK.lastIndex = p;
        let auto = AUTOLINK.exec(text);
        let target: string | undefined = auto ? auto[1] : undefined;
        if (!auto) {
          EMAIL.lastIndex = p;
          auto = EMAIL.exec(text);
          if (auto) target = `mailto:${auto[1]}`;
        }
        if (auto && target) {
          flush();
          const node = mk('text', auto[1]);
          node.link = target;
          nodes.push(node);
          p += auto[0].length;
          break;
        }
        parts.push('<');
        p++;
        break;
      }
      case '&': {
        ENTITY.lastIndex = p;
        const ent = ENTITY.exec(text);
        const decoded = ent ? decodeEntity(ent[1]) : null;
        if (ent && decoded !== null) {
          parts.push(decoded);
          p += ent[0].length;
        } else {
          parts.push('&');
          p++;
        }
        break;
      }
    }
  }
  flush();
  processEmphasis(null);
  // Delimiters that matched (fully or partly) keep only their unused characters as literal text.
  for (const d of allDelims) d.ref.s = d.ch.repeat(d.n);
  return nodesToInlines(nodes, used);
}

function nodesToInlines(nodes: INode[], used: Set<string>): Inline[] {
  const out: Inline[] = [];
  let bold = 0;
  let italic = 0;
  let strike = 0;
  const st: { link: Hyperlink | null; url: string | undefined; run: Run | null; key: string } = {
    link: null,
    url: undefined,
    run: null,
    key: '',
  };

  const setLink = (url: string | undefined): void => {
    if (url === st.url) return;
    st.run = null;
    st.url = url;
    if (url === undefined) st.link = null;
    else {
      st.link = { kind: 'hyperlink', url, children: [], attrs: {} };
      out.push(st.link);
    }
  };

  const runFor = (code: boolean): Run => {
    const key = `${bold > 0 ? 'b' : ''}${italic > 0 ? 'i' : ''}${strike > 0 ? 's' : ''}${code ? 'c' : ''}`;
    if (st.run && key === st.key) return st.run;
    const props: RunProperties = {};
    if (bold > 0) props.bold = true;
    if (italic > 0) props.italic = true;
    if (strike > 0) props.strike = true;
    if (code) {
      props.style = 'InlineCode';
      props.fonts = { ...MONO_FONTS };
      used.add('InlineCode');
    } else if (st.url !== undefined) {
      props.style = 'Hyperlink';
      used.add('Hyperlink');
    }
    const run = newRun(props, []);
    st.run = run;
    st.key = key;
    (st.link ? st.link.children : out).push(run);
    return run;
  };

  for (const node of nodes) {
    bold += node.b;
    italic += node.i;
    strike += node.k;
    if (node.t === 'br') {
      runFor(false).content.push({ kind: 'break' });
      continue;
    }
    if (node.t === 'image' && node.link === undefined) {
      setLink(node.url);
      const placeholder = newRun({ style: 'ImagePlaceholder' }, []);
      used.add('ImagePlaceholder');
      appendText(placeholder.content, node.s ? `[Image: ${node.s}]` : '[Image]');
      st.link!.children.push(placeholder);
      // Each image is its own hyperlink, even when two in a row share a destination.
      st.link = null;
      st.url = undefined;
      st.run = null;
      continue;
    }
    const text = node.t === 'image' ? (node.s ? `[Image: ${node.s}]` : '[Image]') : node.s;
    if (!text) continue;
    setLink(node.link);
    appendText(runFor(node.t === 'code').content, text);
  }
  return out;
}

// --- Block parsing -------------------------------------------------------------------------------

interface Ctx {
  depth: number;
  quote: number;
  level: number;
}

const isBlank = (line: string): boolean => {
  for (let i = 0; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
};

/** Width of leading whitespace in columns (tab stops of 4) and the index of the first other character. */
function leading(line: string): { cols: number; idx: number } {
  let cols = 0;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') cols++;
    else if (c === '\t') cols += 4 - (cols % 4);
    else break;
  }
  return { cols, idx: i };
}

/** Removes up to `n` columns of leading whitespace. */
function stripCols(line: string, n: number): string {
  let cols = 0;
  let i = 0;
  while (i < line.length && cols < n) {
    const c = line[i];
    if (c === ' ') cols++;
    else if (c === '\t') {
      const width = 4 - (cols % 4);
      if (cols + width > n) return ' '.repeat(cols + width - n) + line.slice(i + 1);
      cols += width;
    } else break;
    i++;
  }
  return line.slice(i);
}

const ltrim = (line: string): string => line.slice(leading(line).idx);

interface Fence {
  ch: string;
  len: number;
  cols: number;
}

function fenceStart(line: string, cols: number, idx: number): Fence | null {
  if (cols >= 4) return null;
  const ch = line[idx];
  if (ch !== '`' && ch !== '~') return null;
  let j = idx;
  while (line[j] === ch) j++;
  if (j - idx < 3) return null;
  if (ch === '`' && line.indexOf('`', j) >= 0) return null;
  return { ch, len: j - idx, cols };
}

function fenceEnds(line: string, fence: Fence): boolean {
  const { cols, idx } = leading(line);
  if (cols >= 4 || line[idx] !== fence.ch) return false;
  let j = idx;
  while (line[j] === fence.ch) j++;
  return j - idx >= fence.len && isBlank(line.slice(j));
}

function atxHeading(line: string, cols: number, idx: number): { level: number; text: string } | null {
  if (cols >= 4 || line[idx] !== '#') return null;
  let j = idx;
  while (line[j] === '#') j++;
  const level = j - idx;
  if (level > 6) return null;
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
  let rest = line.slice(j).trim();
  let k = rest.length;
  while (k > 0 && rest[k - 1] === '#') k--;
  if (k === 0) rest = '';
  else if (k < rest.length && (rest[k - 1] === ' ' || rest[k - 1] === '\t')) rest = rest.slice(0, k).trimEnd();
  return { level, text: rest };
}

function isHr(line: string, cols: number, idx: number): boolean {
  if (cols >= 4) return false;
  const c = line[idx];
  if (c !== '-' && c !== '*' && c !== '_') return false;
  let count = 0;
  for (let j = idx; j < line.length; j++) {
    const ch = line[j];
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}

/** 1 for "===", 2 for "---" (setext underline), else 0. */
function setextLevel(line: string): number {
  const { cols, idx } = leading(line);
  if (cols >= 4) return 0;
  const c = line[idx];
  if (c !== '=' && c !== '-') return 0;
  let j = idx;
  while (line[j] === c) j++;
  if (!isBlank(line.slice(j))) return 0;
  return c === '=' ? 1 : 2;
}

interface Marker {
  ordered: boolean;
  /** Bullet character, or "." / ")" for ordered lists. */
  marker: string;
  start: number;
  /** Column where the item's content starts (continuation lines must be indented at least this far). */
  contentCol: number;
  /** Index in the line where the first line's content starts. */
  contentIdx: number;
}

function listMarker(line: string, cols: number, idx: number): Marker | null {
  if (cols >= 4) return null;
  const c = line[idx];
  let ordered = false;
  let marker: string;
  let start = 1;
  let len: number;
  if (c === '-' || c === '+' || c === '*') {
    marker = c;
    len = 1;
  } else if (c >= '0' && c <= '9') {
    let j = idx;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    if (j - idx > 9) return null;
    const delim = line[j];
    if (delim !== '.' && delim !== ')') return null;
    ordered = true;
    marker = delim;
    start = parseInt(line.slice(idx, j), 10);
    len = j + 1 - idx;
  } else return null;
  const after = idx + len;
  const next = line[after];
  if (next !== undefined && next !== ' ' && next !== '\t') return null;
  let col = cols + len;
  let j = after;
  const colStart = col;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    col += line[j] === '\t' ? 4 - (col % 4) : 1;
    j++;
  }
  if (j >= line.length) return { ordered, marker, start, contentCol: colStart + 1, contentIdx: line.length };
  if (col - colStart >= 5) return { ordered, marker, start, contentCol: colStart + 1, contentIdx: after + 1 };
  return { ordered, marker, start, contentCol: col, contentIdx: j };
}

/** Whether a (non-blank) line starts a block that can interrupt a paragraph. */
function interrupts(line: string): boolean {
  const { cols, idx } = leading(line);
  if (cols >= 4) return false;
  if (line[idx] === '>') return true;
  if (atxHeading(line, cols, idx) || fenceStart(line, cols, idx) || isHr(line, cols, idx)) return true;
  const m = listMarker(line, cols, idx);
  return !!m && m.contentIdx < line.length && (!m.ordered || m.start === 1);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) {
    let backslashes = 0;
    for (let i = s.length - 2; i >= 0 && s[i] === '\\'; i--) backslashes++;
    if (backslashes % 2 === 0) s = s.slice(0, -1);
  }
  const cells: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '|') {
      cells.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  cells.push(s.slice(start).trim());
  return cells;
}

/** If lines[i] and lines[i+1] are a GFM table header and delimiter row, its header cells and alignments. */
function tableAt(lines: string[], i: number): { header: string[]; aligns: (string | null)[] } | null {
  const head = lines[i];
  const delim = lines[i + 1];
  if (delim === undefined || head.indexOf('|') < 0 || delim.indexOf('|') < 0) return null;
  for (let k = 0; k < delim.length; k++) {
    const c = delim[k];
    if (c !== '|' && c !== ':' && c !== '-' && c !== ' ' && c !== '\t') return null;
  }
  if (leading(delim).cols >= 4 || leading(head).cols >= 4) return null;
  const aligns: (string | null)[] = [];
  for (const mark of splitRow(delim)) {
    if (!/^:?-+:?$/.test(mark)) return null;
    aligns.push(mark[0] === ':' ? (mark.endsWith(':') ? 'center' : 'left') : mark.endsWith(':') ? 'right' : null);
  }
  const header = splitRow(head);
  if (header.length !== aligns.length) return null;
  return { header, aligns };
}

const DEFINITION = /^ {0,3}\[([^\]\n]{1,999})\]:[ \t]*\n?[ \t]*(<[^<>\n]*>|[^\s<]\S*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*(?:\n|$)/;

const BULLETS = ['•', '–', '•'];
const ORDERED_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'];

class Builder {
  readonly doc: WordDocument;
  readonly refs = new Map<string, string>();
  readonly pending: { p: Paragraph; text: string }[] = [];
  readonly used = new Set<string>();
  /** Paragraphs made from ordinary text (candidates for becoming list items). */
  readonly plain = new WeakSet<Paragraph>();
  private nextAbstract: number;
  private nextInstance: number;

  constructor(doc: WordDocument) {
    this.doc = doc;
    this.nextAbstract = doc.numbering.abstracts.reduce((m, a) => Math.max(m, a.id), -1) + 1;
    this.nextInstance = doc.numbering.instances.reduce((m, a) => Math.max(m, a.id), 0) + 1;
  }

  paragraph(text: string, ctx: Ctx): Paragraph {
    const props: ParagraphProperties = {};
    if (ctx.quote > 0) {
      props.style = 'Quote';
      this.used.add('Quote');
      if (ctx.quote > 1) props.indent = { left: 720 * (ctx.quote - 1) };
    }
    const p = newParagraph(props);
    this.plain.add(p);
    this.pending.push({ p, text });
    return p;
  }

  heading(level: number, text: string): Paragraph {
    const style = `Heading${level}`;
    this.used.add(style);
    const p = newParagraph({ style });
    this.pending.push({ p, text });
    return p;
  }

  code(text: string): Paragraph {
    this.used.add('Code');
    const content: RunContent[] = [];
    appendText(content, text);
    return newParagraph({ style: 'Code' }, content.length ? [newRun({}, content)] : []);
  }

  rule(): Paragraph {
    return newParagraph({ borders: { bottom: { val: 'single', sz: 6, space: 1, color: 'A6A6A6' } } });
  }

  /** A fresh numbering definition (own counters) for one list; returns the numId. */
  newList(ordered: boolean, start: number, level: number): number {
    const levels: NumberingLevel[] = [];
    for (let l = 0; l < 9; l++) {
      levels.push({
        level: l,
        start: l === level ? start : 1,
        format: ordered ? ORDERED_FORMATS[l % 3] : 'bullet',
        suffix: 'tab',
        text: ordered ? `%${l + 1}.` : BULLETS[l % 3],
        justification: 'left',
        paragraphProperties: { indent: { left: 720 * (l + 1), hanging: 360 } },
        attrs: {},
      });
    }
    const abstractId = this.nextAbstract++;
    const id = this.nextInstance++;
    this.doc.numbering.abstracts.push({ id: abstractId, multiLevelType: 'hybridMultilevel', levels, attrs: {} });
    this.doc.numbering.instances.push({ id, abstractId, overrides: [], attrs: {} });
    return id;
  }

  table(header: string[], aligns: (string | null)[], rows: string[][]): Table {
    const cols = header.length;
    const width = Math.floor(PAGE_TEXT_WIDTH / cols);
    const build = (cells: string[], isHeader: boolean): TableRow => {
      const out: TableCell[] = [];
      for (let c = 0; c < cols; c++) {
        const align = aligns[c];
        const p = newParagraph(align ? { justification: align } : {});
        this.pending.push({ p, text: (cells[c] ?? '').replace(/\\\|/g, '|') });
        out.push({
          kind: 'cell',
          properties: {
            width: { w: String(width), type: 'dxa' },
            ...(isHeader ? { shading: { val: 'clear', color: 'auto', fill: 'F2F2F2' } } : {}),
          },
          children: [p],
          attrs: {},
        });
      }
      return { kind: 'row', properties: isHeader ? { header: true } : {}, cells: out, attrs: {} };
    };
    return {
      kind: 'table',
      properties: { style: 'TableGrid', width: { w: '0', type: 'auto' }, look: { val: '0420', firstRow: true, noVBand: true } },
      grid: new Array<number>(cols).fill(width),
      rows: [build(header, true), ...rows.map((r) => build(r, false))],
    };
  }

  /** Runs the deferred inline parsing (it needs every link definition, so it waits for the block pass). */
  finish(): void {
    for (const { p, text } of this.pending) p.children = parseInline(text, this.refs, this.used);
  }

  /** Adds the styles the document ended up using. */
  install(): void {
    const have = new Set(this.doc.styles.styles.map((s) => s.id));
    for (const id of [...this.used, 'TableGrid']) {
      if (have.has(id)) continue;
      const style = styleFor(id);
      if (style) this.doc.styles.styles.push(style);
    }
  }
}

function parseBlocks(b: Builder, lines: string[], ctx: Ctx, out: Block[]): void {
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const { cols, idx } = leading(line);

    // Indented code block.
    if (cols >= 4) {
      let j = i;
      let lastCode = i;
      while (j < n && (isBlank(lines[j]) || leading(lines[j]).cols >= 4)) {
        if (!isBlank(lines[j])) lastCode = j;
        j++;
      }
      for (let k = i; k <= lastCode; k++) out.push(b.code(isBlank(lines[k]) ? '' : stripCols(lines[k], 4)));
      i = lastCode + 1;
      continue;
    }

    // Fenced code block (info string is dropped: the model has nowhere to keep it).
    const fence = fenceStart(line, cols, idx);
    if (fence) {
      let j = i + 1;
      let count = 0;
      while (j < n && !fenceEnds(lines[j], fence)) {
        out.push(b.code(stripCols(lines[j], fence.cols)));
        count++;
        j++;
      }
      if (!count) out.push(b.code(''));
      i = j + 1;
      continue;
    }

    const atx = atxHeading(line, cols, idx);
    if (atx) {
      out.push(b.heading(atx.level, atx.text));
      i++;
      continue;
    }

    if (isHr(line, cols, idx)) {
      out.push(b.rule());
      i++;
      continue;
    }

    const nest = ctx.depth < MAX_DEPTH;

    // Block quote.
    if (nest && line[idx] === '>') {
      const inner: string[] = [];
      let j = i;
      while (j < n) {
        const l = lines[j];
        const w = leading(l);
        if (w.cols < 4 && l[w.idx] === '>') {
          let s = w.idx + 1;
          if (l[s] === ' ' || l[s] === '\t') s++;
          inner.push(l.slice(s));
          j++;
          continue;
        }
        // Lazy continuation: an unmarked line continuing the quote's last paragraph.
        const last = inner[inner.length - 1];
        if (!isBlank(l) && last !== undefined && !isBlank(last) && !interrupts(l) && !interrupts(last)) {
          inner.push(l);
          j++;
          continue;
        }
        break;
      }
      parseBlocks(b, inner, { depth: ctx.depth + 1, quote: ctx.quote + 1, level: ctx.level }, out);
      i = j;
      continue;
    }

    // List.
    const first = nest ? listMarker(line, cols, idx) : null;
    if (first) {
      const items: { lines: string[] }[] = [];
      let j = i;
      while (j < n) {
        const l = lines[j];
        const w = leading(l);
        const m = listMarker(l, w.cols, w.idx);
        if (!m || m.ordered !== first.ordered || m.marker !== first.marker || isHr(l, w.cols, w.idx)) break;
        const item = { lines: [l.slice(m.contentIdx)] };
        j++;
        while (j < n) {
          const l2 = lines[j];
          if (isBlank(l2)) {
            let k = j;
            while (k < n && isBlank(lines[k])) k++;
            if (k >= n || (item.lines.length === 1 && item.lines[0] === '')) break;
            if (leading(lines[k]).cols >= m.contentCol) {
              for (let t = j; t < k; t++) item.lines.push('');
              j = k;
              continue;
            }
            break;
          }
          const w2 = leading(l2);
          if (w2.cols >= m.contentCol) {
            item.lines.push(stripCols(l2, m.contentCol));
            j++;
            continue;
          }
          const prev = item.lines[item.lines.length - 1];
          if (prev !== '' && !isBlank(prev) && !listMarker(l2, w2.cols, w2.idx) && !interrupts(l2)) {
            item.lines.push(l2);
            j++;
            continue;
          }
          break;
        }
        items.push(item);
        while (j < n && isBlank(lines[j])) j++;
      }
      const level = Math.min(ctx.level, 8);
      const numId = b.newList(first.ordered, first.start, level);
      const childCtx: Ctx = { depth: ctx.depth + 1, quote: ctx.quote, level: ctx.level + 1 };
      for (const item of items) {
        const blocks: Block[] = [];
        parseBlocks(b, item.lines, childCtx, blocks);
        const head = blocks[0];
        const numbering: NumberingReference = { id: numId, level };
        if (head && head.kind === 'paragraph' && b.plain.has(head)) {
          head.properties = { style: 'ListParagraph', numbering };
        } else {
          blocks.unshift(newParagraph({ style: 'ListParagraph', numbering }));
        }
        for (let k = 1; k < blocks.length; k++) {
          const blk = blocks[k];
          if (blk.kind === 'paragraph' && b.plain.has(blk) && !blk.properties.numbering) {
            blk.properties = { style: 'ListParagraph', indent: { left: 720 * (level + 1) } };
          }
        }
        b.used.add('ListParagraph');
        out.push(...blocks);
      }
      i = j;
      continue;
    }

    // Table.
    const table = line.indexOf('|') >= 0 ? tableAt(lines, i) : null;
    if (table) {
      const rows: string[][] = [];
      let j = i + 2;
      while (j < n && !isBlank(lines[j]) && !interrupts(lines[j])) rows.push(splitRow(lines[j++]));
      out.push(b.table(table.header, table.aligns, rows));
      i = j;
      continue;
    }

    // Paragraph (possibly a setext heading, possibly starting with link reference definitions).
    const partsText: string[] = [line.slice(idx)];
    let j = i + 1;
    let setext = 0;
    while (j < n) {
      const l = lines[j];
      if (isBlank(l)) break;
      setext = setextLevel(l);
      if (setext) {
        j++;
        break;
      }
      if (interrupts(l) || (l.indexOf('|') >= 0 && tableAt(lines, j))) break;
      partsText.push(ltrim(l));
      j++;
    }
    i = j;
    let text = partsText.join('\n').trimEnd();
    while (text.startsWith('[')) {
      const m = DEFINITION.exec(text);
      if (!m || m[1].trim() === '' || m[1].trim().startsWith('^')) break;
      const key = normalizeLabel(m[1]);
      if (!b.refs.has(key)) {
        let dest = m[2];
        if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1);
        b.refs.set(key, unescapeUrl(dest));
      }
      text = text.slice(m[0].length).trimStart();
    }
    if (!text) continue;
    if (setext) out.push(b.heading(setext, text));
    else out.push(b.paragraph(text, ctx));
  }
}

/**
 * Parses Markdown into a new document: headings, paragraphs, emphasis/strong/strikethrough/code,
 * links, images (as placeholders), bullet/ordered lists with nesting (real numbering), block
 * quotes, fenced/indented code blocks, horizontal rules, GFM tables and hard line breaks.
 * Never throws; unknown syntax stays literal text.
 */
export async function markdownToDocument(source: string): Promise<WordDocument> {
  let text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  try {
    const doc = await WordDocument.create();
    const builder = new Builder(doc);
    const body: Block[] = [];
    parseBlocks(builder, lines, { depth: 0, quote: 0, level: 0 }, body);
    builder.finish();
    builder.install();
    doc.body = body.length ? body : [newParagraph({})];
    return doc;
  } catch {
    // Safety net: literal text, one paragraph per line.
    const doc = await WordDocument.create();
    doc.body = lines.map((line) => {
      const content: RunContent[] = [];
      appendText(content, line);
      return newParagraph({}, content.length ? [newRun({}, content)] : []);
    });
    return doc;
  }
}

// --- Export --------------------------------------------------------------------------------------

interface Seg {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link?: string;
  /** Already-formatted Markdown (images, autolinks): emitted verbatim. */
  raw?: boolean;
  /** A line break. */
  br?: boolean;
}

type Mode = 'block' | 'heading' | 'cell';
type Kind = { kind: 'heading'; level: number } | { kind: 'quote' } | { kind: 'code' } | { kind: 'normal' };

const MONO_RE = /courier|consolas|mono|menlo|monaco|source code|lucida console/i;
const CODE_STYLES = new Set(['code', 'sourcecode', 'htmlpreformatted', 'codeblock', 'preformattedtext', 'htmlcode', 'codechar', 'inlinecode']);
const QUOTE_STYLES = new Set(['quote', 'intensequote', 'blocktext', 'blockquote']);
const isWordChar = (c: string): boolean => c !== '' && /[\p{L}\p{N}]/u.test(c);
const isSpaceTab = (c: string | undefined): boolean => c === ' ' || c === '\t';

/** Where in `plain` Markdown syntax would be triggered by literal text, so it must be backslash-escaped. */
function computeEscapes(plain: string, drop: Uint8Array, inLink: Uint8Array, mode: Mode): Uint8Array {
  const n = plain.length;
  const esc = new Uint8Array(n);
  let nextClose: Int32Array | null = null;
  const closeAfter = (i: number): number => {
    if (!nextClose) {
      nextClose = new Int32Array(n + 1);
      let next = -1;
      nextClose[n] = -1;
      for (let k = n - 1; k >= 0; k--) {
        if (plain[k] === ']') next = k;
        nextClose[k] = next;
      }
    }
    return nextClose[i];
  };
  const lineOnly = (i: number, ch: string): boolean => {
    for (let k = i; k < n && plain[k] !== '\n'; k++) if (plain[k] !== ch && !isSpaceTab(plain[k])) return false;
    return true;
  };
  let lineStart = mode === 'block';
  let last = -1;
  for (let i = 0; i < n; i++) {
    const c = plain[i];
    if (c === '\n') {
      lineStart = mode === 'block';
      continue;
    }
    if (drop[i]) continue;
    const prev = i > 0 ? plain[i - 1] : '';
    const next = i + 1 < n ? plain[i + 1] : '';
    switch (c) {
      case '\\':
        if (next === '' || next === '\n' || isPunct(next)) esc[i] = 1;
        break;
      case '`':
      case '*':
        esc[i] = 1;
        break;
      case '_':
        if (!(isWordChar(prev) && isWordChar(next))) esc[i] = 1;
        break;
      case '~':
        if (prev === '~' || next === '~') esc[i] = 1;
        break;
      case '<':
        if (next !== '' && /[A-Za-z/!?]/.test(next)) esc[i] = 1;
        break;
      case '&': {
        ENTITY.lastIndex = i;
        if (ENTITY.test(plain)) esc[i] = 1;
        break;
      }
      case '[': {
        if (inLink[i]) esc[i] = 1;
        else {
          const close = closeAfter(i + 1);
          if (close >= 0) {
            const after = plain[close + 1];
            if (after === '(' || after === '[' || (lineStart && after === ':' && next !== '^')) esc[i] = 1;
          }
        }
        break;
      }
      case ']':
        if (inLink[i]) esc[i] = 1;
        break;
      case '|':
        if (mode === 'cell') esc[i] = 1;
        break;
      case '#':
        if (lineStart) {
          let j = i;
          while (plain[j] === '#') j++;
          if (j - i <= 6 && (j >= n || isSpaceTab(plain[j]) || plain[j] === '\n')) esc[i] = 1;
        }
        break;
      case '>':
        if (lineStart) esc[i] = 1;
        break;
      case '+':
      case '-':
        if (lineStart && (next === '' || isSpaceTab(next) || next === '\n' || (c === '-' && lineOnly(i, '-')))) esc[i] = 1;
        break;
      case '=':
        if (lineStart && lineOnly(i, '=')) esc[i] = 1;
        break;
      default:
        if (lineStart && c >= '0' && c <= '9') {
          let j = i;
          while (plain[j] >= '0' && plain[j] <= '9') j++;
          if (j - i <= 9 && (plain[j] === '.' || plain[j] === ')') && (j + 1 >= n || isSpaceTab(plain[j + 1]) || plain[j + 1] === '\n')) esc[j] = 1;
        }
    }
    lineStart = false;
    last = i;
  }
  if (mode === 'heading' && last >= 0 && plain[last] === '#') esc[last] = 1;
  return esc;
}

function codeSpan(text: string, mode: Mode): string {
  let t = text.replace(/[\r\n]+/g, ' ');
  if (mode === 'cell') t = t.replace(/\|/g, '\\|');
  let longest = 0;
  const re = /`+/g;
  for (let m = re.exec(t); m; m = re.exec(t)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest ? longest + 1 : 1);
  const pad = t.startsWith('`') || t.endsWith('`') || (t.startsWith(' ') && t.endsWith(' ') && t.trim() !== '') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

function formatDest(url: string): string {
  if (url === '') return '<>';
  if (/[\s<>()\u0000-\u001f]/.test(url)) return `<${url.replace(/[<>\\]/g, (m) => `\\${m}`)}>`;
  return url.replace(/\\/g, '\\\\');
}

const escapeAlt = (alt: string): string => alt.replace(/[\\[\]]/g, (m) => `\\${m}`).replace(/[\r\n]+/g, ' ');

// Mark keys: "S" strike, "B" bold, "I" italic, "L<url>" link. "B_" and "I_" are bold/italic written with
// underscores, used where a "*" delimiter would run into the "*" closing the previous mark.
const markOpen = (key: string): string =>
  key === 'S' ? '~~' : key === 'B' ? '**' : key === 'I' ? '*' : key === 'B_' ? '__' : key === 'I_' ? '_' : '[';
const markClose = (key: string): string =>
  key === 'S' ? '~~' : key === 'B' ? '**' : key === 'I' ? '*' : key === 'B_' ? '__' : key === 'I_' ? '_' : `](${formatDest(key.slice(1))})`;
const baseKey = (key: string): string => (key.endsWith('_') ? key.slice(0, -1) : key);

/** Segments to a single Markdown string (breaks become "\<newline>", or <br> in table cells). */
function renderInline(input: Seg[], mode: Mode): string {
  // Merge neighbours with the same formatting, collapse breaks, trim breaks at the ends.
  const segs: Seg[] = [];
  for (const seg of input) {
    const last = segs[segs.length - 1];
    if (seg.br) {
      if (mode === 'heading') {
        if (last && !last.raw) last.text += ' ';
      } else if (last && !last.br) segs.push({ ...seg });
      continue;
    }
    const text = seg.raw ? seg.text : seg.text.replace(/[\r\n]+/g, ' ');
    if (!text) continue;
    if (
      last &&
      !last.br &&
      !last.raw &&
      !seg.raw &&
      last.bold === seg.bold &&
      last.italic === seg.italic &&
      last.strike === seg.strike &&
      last.code === seg.code &&
      last.link === seg.link
    ) {
      last.text += text;
    } else segs.push({ ...seg, text });
  }
  while (segs.length && segs[segs.length - 1].br) segs.pop();
  while (segs.length && segs[0].br) segs.shift();
  // A link whose text is its own address reads better as an autolink.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.link && !s.code && s.text === s.link && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]+$/.test(s.link) && segs[i - 1]?.link !== s.link && segs[i + 1]?.link !== s.link) {
      s.text = `<${s.link}>`;
      s.raw = true;
      s.link = undefined;
    }
  }
  if (!segs.length) return '';

  // The text as Markdown sees it (code and raw parts as inert placeholders), to decide what to escape.
  const pieces: string[] = [];
  const spans: number[] = [];
  let total = 0;
  for (const s of segs) {
    const t = s.br ? '\n' : s.code || s.raw ? 'x'.repeat(s.text.length) : s.text;
    pieces.push(t);
    spans.push(t.length);
    total += t.length;
  }
  const plain = pieces.join('');
  const inLink = new Uint8Array(total);
  const drop = new Uint8Array(total);
  let at = 0;
  segs.forEach((s, i) => {
    if (s.link) inLink.fill(1, at, at + spans[i]);
    at += spans[i];
  });
  // Whitespace at the start and end of a line is not significant in Markdown.
  for (let s = 0; s <= total; ) {
    let e = plain.indexOf('\n', s);
    if (e < 0) e = total;
    let a = s;
    while (a < e && isSpaceTab(plain[a])) drop[a++] = 1;
    let z = e;
    while (z > a && isSpaceTab(plain[z - 1])) drop[--z] = 1;
    s = e + 1;
  }
  const esc = computeEscapes(plain, drop, inLink, mode);

  const out: string[] = [];
  const open: string[] = [];
  let pend = '';
  at = 0;
  segs.forEach((s, i) => {
    const start = at;
    at += spans[i];
    if (s.br) {
      pend = '';
      out.push(mode === 'cell' ? '<br>' : '\\\n');
      return;
    }
    let core: string;
    if (s.raw) core = s.text;
    else if (s.code) core = codeSpan(s.text, mode);
    else {
      const chars: string[] = [];
      for (let k = start; k < at; k++) {
        if (drop[k]) continue;
        if (esc[k]) chars.push('\\');
        chars.push(plain[k]);
      }
      core = chars.join('');
    }
    if (core.trim() === '') {
      pend += core;
      return;
    }
    let lead = '';
    let trail = '';
    if (!s.raw && !s.code) {
      let a = 0;
      while (a < core.length && isSpaceTab(core[a])) a++;
      let z = core.length;
      while (z > a && isSpaceTab(core[z - 1])) z--;
      lead = core.slice(0, a);
      trail = core.slice(z);
      core = core.slice(a, z);
    }
    const needed: string[] = [];
    if (s.link) needed.push(`L${s.link}`);
    if (s.strike) needed.push('S');
    if (s.bold) needed.push('B');
    if (s.italic) needed.push('I');
    let keep = 0;
    while (keep < open.length && needed.includes(baseKey(open[keep]))) keep++;
    let closers = '';
    for (const key of open.splice(keep).reverse()) closers += markClose(key);
    // "*" closers directly followed by "*" openers would fuse into one ambiguous delimiter run.
    const fuse = closers.endsWith('*') && !pend && !lead;
    let openers = '';
    for (const base of needed) {
      if (!open.some((k) => baseKey(k) === base)) {
        const key = fuse && (base === 'B' || base === 'I') ? `${base}_` : base;
        open.push(key);
        openers += markOpen(key);
      }
    }
    out.push(closers, pend, lead, openers, core);
    pend = trail;
  });
  let closers = '';
  for (const key of open.reverse()) closers += markClose(key);
  out.push(closers);
  return out.join('');
}

class Exporter {
  private readonly resolver: StyleResolver;
  private readonly body: Block[];
  private readonly chunks: string[] = [];
  private prev: 'none' | 'list' | 'listcont' | 'other' = 'none';
  private levels: ({ id: number; ordered: boolean; parity: number; count: number; col: number } | undefined)[] = [];
  private lastCol = 0;
  private readonly kinds = new Map<string | undefined, Kind>();

  constructor(doc: WordDocument) {
    this.resolver = new StyleResolver(doc.styles, doc.theme, doc.numbering);
    this.body = doc.body;
  }

  run(): string {
    const blocks = this.flatten(this.body);
    let i = 0;
    while (i < blocks.length) {
      const block = blocks[i];
      if (block.kind === 'table') {
        const text = this.table(block);
        if (text) {
          this.emit(text, false);
          this.reset();
        }
        i++;
        continue;
      }
      if (block.kind !== 'paragraph') {
        i++;
        continue;
      }
      const kind = this.classify(block);
      if (kind.kind === 'code') {
        const paras: Paragraph[] = [];
        while (i < blocks.length) {
          const b = blocks[i];
          if (b.kind !== 'paragraph' || this.classify(b).kind !== 'code') break;
          paras.push(b);
          i++;
        }
        this.codeBlock(paras);
        continue;
      }
      if (kind.kind === 'quote') {
        const paras: Paragraph[] = [];
        while (i < blocks.length) {
          const b = blocks[i];
          if (b.kind !== 'paragraph' || this.classify(b).kind !== 'quote') break;
          paras.push(b);
          i++;
        }
        this.quote(paras);
        continue;
      }
      i++;
      this.paragraph(block, kind);
    }
    return this.chunks.length ? `${this.chunks.join('')}\n` : '';
  }

  private flatten(blocks: readonly Block[], out: Block[] = []): Block[] {
    for (const b of blocks) {
      if (b.kind === 'wrapper') this.flatten(b.children, out);
      else out.push(b);
    }
    return out;
  }

  private emit(text: string, tight: boolean): void {
    if (this.chunks.length) this.chunks.push(tight ? '\n' : '\n\n');
    this.chunks.push(text);
  }

  private reset(): void {
    this.levels = [];
    this.prev = 'other';
  }

  private classify(p: Paragraph): Kind {
    const cached = this.kinds.get(p.properties.style);
    if (cached) return this.withDirect(p, cached);
    let result: Kind | undefined;
    const chain = this.resolver.chain(p.properties.style, 'paragraph');
    for (let i = chain.length - 1; i >= 0 && !result; i--) {
      const id = chain[i].id.toLowerCase().replace(/\s+/g, '');
      const name = (chain[i].name ?? '').toLowerCase().replace(/\s+/g, '');
      const heading = /^heading([1-6])$/.exec(id) ?? /^heading([1-6])$/.exec(name);
      if (heading) result = { kind: 'heading', level: Number(heading[1]) };
      else if (id === 'title' || name === 'title') result = { kind: 'heading', level: 1 };
      else if (QUOTE_STYLES.has(id) || QUOTE_STYLES.has(name)) result = { kind: 'quote' };
      else if (CODE_STYLES.has(id) || CODE_STYLES.has(name)) result = { kind: 'code' };
    }
    if (!result) {
      const outline = this.resolver.paragraph({ style: p.properties.style }).outlineLevel;
      result = outline !== undefined && outline >= 0 && outline <= 5 ? { kind: 'heading', level: outline + 1 } : { kind: 'normal' };
    }
    this.kinds.set(p.properties.style, result);
    return this.withDirect(p, result);
  }

  /** Direct outline level on an otherwise ordinary paragraph makes it a heading. */
  private withDirect(p: Paragraph, kind: Kind): Kind {
    const direct = p.properties.outlineLevel;
    return kind.kind === 'normal' && direct !== undefined && direct >= 0 && direct <= 5 ? { kind: 'heading', level: direct + 1 } : kind;
  }

  // --- Inline text ---

  private marks(props: RunProperties): { bold: boolean; italic: boolean; strike: boolean; code: boolean } {
    let bold: boolean | undefined;
    let italic: boolean | undefined;
    let strike: boolean | undefined;
    let font: string | undefined;
    let code = false;
    const apply = (r: RunProperties | undefined): void => {
      if (!r) return;
      if (r.bold !== undefined) bold = r.bold;
      if (r.italic !== undefined) italic = r.italic;
      if (r.strike !== undefined) strike = r.strike;
      if (r.fonts?.ascii ?? r.fonts?.hAnsi) font = r.fonts?.ascii ?? r.fonts?.hAnsi;
    };
    if (props.style) {
      for (const style of this.resolver.chain(props.style, 'character')) {
        apply(style.runProperties);
        if (CODE_STYLES.has(style.id.toLowerCase())) code = true;
      }
      // The style may be missing from the stylesheet (chain() then falls back to the default).
      if (CODE_STYLES.has(props.style.toLowerCase())) code = true;
    }
    apply(props);
    return { bold: !!bold, italic: !!italic, strike: !!strike, code: code || (font !== undefined && MONO_RE.test(font)) };
  }

  private segments(inlines: readonly Inline[]): Seg[] {
    const segs: Seg[] = [];
    const plainFmt = { bold: false, italic: false, strike: false, code: false };
    const walk = (list: readonly Inline[], link: string | undefined): void => {
      for (const inline of list) {
        switch (inline.kind) {
          case 'run': {
            const fmt = this.marks(inline.properties);
            let acc = '';
            const flush = (): void => {
              if (acc) segs.push({ text: acc, ...fmt, link });
              acc = '';
            };
            for (const item of inline.content) {
              switch (item.kind) {
                case 'text':
                  acc += item.text;
                  break;
                case 'tab':
                  acc += '\t';
                  break;
                case 'noBreakHyphen':
                  acc += '-';
                  break;
                case 'break':
                  if (!item.type || item.type === 'textWrapping') {
                    flush();
                    segs.push({ text: '', ...plainFmt, br: true });
                  }
                  break;
                case 'cr':
                  flush();
                  segs.push({ text: '', ...plainFmt, br: true });
                  break;
                case 'drawing': {
                  flush();
                  const name = item.image ? item.image.slice(item.image.lastIndexOf('/') + 1) : '';
                  segs.push({ text: `![${escapeAlt(item.description || item.name || '')}](${formatDest(name)})`, ...plainFmt, raw: true });
                  break;
                }
                default:
                  break;
              }
            }
            flush();
            break;
          }
          case 'hyperlink': {
            const image = this.imagePlaceholder(inline);
            if (image !== null) segs.push({ text: image, ...plainFmt, raw: true });
            else walk(inline.children, inline.url ?? (inline.anchor !== undefined ? `#${inline.anchor}` : link));
            break;
          }
          case 'wrapper':
            walk(inline.children, link);
            break;
          default:
            break;
        }
      }
    };
    walk(inlines, undefined);
    return segs;
  }

  /** `![alt](url)` for a hyperlink made from an image placeholder, else null. */
  private imagePlaceholder(h: Hyperlink): string | null {
    if (h.url === undefined || !h.children.length) return null;
    let text = '';
    for (const c of h.children) {
      if (c.kind !== 'run' || c.properties.style !== 'ImagePlaceholder') return null;
      for (const item of c.content) if (item.kind === 'text') text += item.text;
    }
    const m = /^\[Image(?:: ([\s\S]*))?\]$/.exec(text);
    if (!m) return null;
    return `![${escapeAlt(m[1] ?? '')}](${formatDest(h.url)})`;
  }

  private text(p: Paragraph, mode: Mode): string {
    return renderInline(this.segments(p.children), mode);
  }

  /** Visible text with no Markdown escaping (code blocks). */
  private rawText(p: Paragraph): string {
    let out = '';
    for (const seg of this.segments(p.children)) out += seg.br ? '\n' : seg.raw ? '' : seg.text;
    return out;
  }

  // --- Blocks ---

  private codeBlock(paras: Paragraph[]): void {
    const lines = paras.map((p) => this.rawText(p));
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    while (lines.length && lines[0].trim() === '') lines.shift();
    if (!lines.length) return;
    const text = lines.join('\n');
    let longest = 0;
    const re = /`+/g;
    for (let m = re.exec(text); m; m = re.exec(text)) longest = Math.max(longest, m[0].length);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    this.emit(`${fence}\n${text}\n${fence}`, false);
    this.reset();
  }

  private quote(paras: Paragraph[]): void {
    const lines: string[] = [];
    let prevDepth = 0;
    const prefix = (d: number): string => Array.from({ length: d }, () => '>').join(' ');
    for (const p of paras) {
      const text = this.text(p, 'block');
      if (!text.trim()) continue;
      const depth = Math.min(8, 1 + Math.max(0, Math.round((p.properties.indent?.left ?? 0) / 720)));
      if (lines.length) lines.push(prefix(Math.min(depth, prevDepth)));
      for (const line of text.split('\n')) lines.push(line ? `${prefix(depth)} ${line}` : prefix(depth));
      prevDepth = depth;
    }
    if (!lines.length) return;
    this.emit(lines.join('\n'), false);
    this.reset();
  }

  private paragraph(p: Paragraph, kind: Kind): void {
    if (kind.kind === 'heading') {
      const text = this.text(p, 'heading');
      if (text.trim()) {
        this.emit(`${'#'.repeat(kind.level)} ${text}`, false);
        this.reset();
      }
      return;
    }
    const resolved = this.resolver.paragraph(p.properties);
    const numId = resolved.numbering?.id;
    if (numId) {
      const level = Math.min(Math.max(resolved.numbering?.level ?? 0, 0), 8);
      const def = this.resolver.listLevel(numId, level);
      if (def && def.format !== 'none') {
        this.listItem(p, numId, level, def);
        return;
      }
    }
    const text = this.text(p, 'block');
    if (!text.trim()) {
      // An empty paragraph carrying a bottom border is a horizontal rule.
      const bottom = resolved.borders?.bottom;
      if (bottom && bottom.val && bottom.val !== 'none' && bottom.val !== 'nil' && !p.children.length) {
        this.emit('---', false);
        this.reset();
      }
      return;
    }
    if ((this.prev === 'list' || this.prev === 'listcont') && this.chainHas(p, 'listparagraph')) {
      const pad = ' '.repeat(this.lastCol);
      this.emit(
        text
          .split('\n')
          .map((line) => (line ? pad + line : line))
          .join('\n'),
        false,
      );
      this.prev = 'listcont';
      return;
    }
    this.emit(text, false);
    this.reset();
  }

  private chainHas(p: Paragraph, id: string): boolean {
    return this.resolver.chain(p.properties.style, 'paragraph').some((s) => s.id.toLowerCase() === id);
  }

  private listItem(p: Paragraph, numId: number, level: number, def: NumberingLevel): void {
    const ordered = def.format !== 'bullet';
    this.levels.length = Math.min(this.levels.length, level + 1);
    let state = this.levels[level];
    let fresh = false;
    if (!state || state.id !== numId || state.ordered !== ordered) {
      // A different list directly after another at the same level must not merge with it on re-import.
      const parity = state && state.ordered === ordered ? state.parity ^ 1 : 0;
      state = { id: numId, ordered, parity, count: (def.start ?? 1) - 1, col: 0 };
      this.levels[level] = state;
      fresh = true;
    }
    state.count++;
    const marker = ordered ? `${state.count}${state.parity ? ')' : '.'}` : state.parity ? '*' : '-';
    const startCol = this.startCol(level);
    state.col = startCol + marker.length + 1;
    const pad = ' '.repeat(state.col);
    const lines = this.text(p, 'block').split('\n');
    const head = `${' '.repeat(startCol)}${marker}${lines[0] ? ` ${lines[0]}` : ''}`;
    const rest = lines.slice(1).map((line) => (line ? pad + line : line));
    // A new top-level list gets a blank line before it (nested lists stay tight under their item).
    this.emit([head, ...rest].join('\n'), this.prev === 'list' && !(fresh && level === 0));
    this.prev = 'list';
    this.lastCol = state.col;
  }

  private startCol(level: number): number {
    if (level === 0) return 0;
    const parent = this.levels[level - 1];
    return parent && parent.col ? parent.col : this.startCol(level - 1) + 2;
  }

  // --- Tables ---

  private cellParagraphs(blocks: readonly Block[], out: Paragraph[] = []): Paragraph[] {
    for (const b of blocks) {
      if (b.kind === 'paragraph') out.push(b);
      else if (b.kind === 'wrapper') this.cellParagraphs(b.children, out);
      else if (b.kind === 'table') {
        for (const row of b.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') this.cellParagraphs(cell.children, out);
      }
    }
    return out;
  }

  private table(t: Table): string {
    const rows: string[][] = [];
    let align: (string | null)[] = [];
    for (const row of t.rows) {
      if (row.kind !== 'row') continue;
      const cells: string[] = [];
      const aligns: (string | null)[] = [];
      for (const cell of row.cells) {
        if (cell.kind !== 'cell') continue;
        const paras = this.cellParagraphs(cell.children);
        const texts = paras.map((p) => this.text(p, 'cell')).filter((s) => s.trim() !== '');
        const merged = cell.properties.vMerge === 'continue';
        cells.push(merged ? '' : texts.join('<br>'));
        const j = paras[0]?.properties.justification;
        const a = j === 'center' ? 'center' : j === 'right' || j === 'end' ? 'right' : j === 'left' || j === 'start' ? 'left' : null;
        aligns.push(a);
        for (let s = (cell.properties.gridSpan ?? 1) - 1; s > 0; s--) {
          cells.push('');
          aligns.push(null);
        }
      }
      if (!rows.length) align = aligns;
      rows.push(cells);
    }
    if (!rows.length) return '';
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const line = (cells: string[]): string => {
      const padded = Array.from({ length: cols }, (_, c) => cells[c] ?? '');
      return `| ${padded.map((c) => c || ' ').join(' | ')} |`;
    };
    const delimiter = Array.from({ length: cols }, (_, c) => {
      const a = align[c] ?? null;
      return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
    });
    return [line(rows[0]), `| ${delimiter.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  }
}

/**
 * Serialises the document as Markdown. Headings, bold/italic/strikethrough/code runs, links,
 * images, lists, block quotes, code blocks, tables and horizontal rules are written as syntax;
 * everything else (colours, fonts, alignment, underline, headers/footers, page breaks...) is
 * dropped but its text is kept. Special characters in text are backslash-escaped.
 */
export function documentToMarkdown(doc: WordDocument): string {
  return new Exporter(doc).run();
}
