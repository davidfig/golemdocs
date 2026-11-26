// Packs DrawingML's preset shape definitions into the table slides and sheets draw from (client/src/drawingml/presetData.ts,
// read by client/src/drawingml/geometry.ts).
//
//   pnpm preset-shapes <presetShapeDefinitions.xml>
//
// The file comes with the ECMA-376 standard (5th edition, Part 1: OfficeOpenXML-DrawingMLGeometries.zip inside
// ECMA-376-1_5th_edition_december_2016.zip, from ecma-international.org). One line for each shape, its fields split by tabs:
//
//   name   adjustments   guides   text box   paths
//
// Adjustments and guides are `name=formula` joined by `;`, in the order they are worked out. The text box is four values
// (left, top, right, bottom). Paths are joined by `|`: each is `flags:commands`, the flags being n (not stroked) and one of
// f (not filled), d, D (darkened a little, more), l, L (lightened), then the path's own width and height if it has them; the
// commands are M, L, A, Q, C and Z with their values. Drag handles and connection sites are left out.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { elements, parseXml, type XmlElement } from '../docx/src/xml/xml.ts';

const input = process.argv[2];
if (!input) throw new Error('usage: pnpm preset-shapes <presetShapeDefinitions.xml>');

const local = (e: XmlElement): string => e.name.slice(e.name.indexOf(':') + 1);
const all = (e: XmlElement | undefined): XmlElement[] => (e ? [...elements(e)] : []);
const child = (e: XmlElement, name: string): XmlElement | undefined => all(e).find((c) => local(c) === name);

const BUILTINS = new Set('w h l t r b hc vc ss ls cd2 cd4 cd8 3cd4 3cd8 5cd8 7cd8'.split(' '));
for (const p of ['wd', 'hd', 'ssd']) for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) BUILTINS.add(p + d);
const SHADES: Record<string, string> = { none: 'f', darken: 'D', darkenLess: 'd', lighten: 'L', lightenLess: 'l', norm: '' };
const COMMANDS: Record<string, string> = { moveTo: 'M', lnTo: 'L', arcTo: 'A', quadBezTo: 'Q', cubicBezTo: 'C', close: 'Z' };
/** How many values each command takes. */
const VALUES: Record<string, number> = { M: 2, L: 2, A: 4, Q: 4, C: 6, Z: 0 };

const lines = new Map<string, string>();
for (const shape of all(parseXml(readFileSync(input, 'utf8').replace(/^﻿/, '')))) {
  const name = local(shape);
  const known = new Set(BUILTINS);
  const check = (token: string | undefined): string => {
    if (token === undefined) throw new Error(`${name}: a value is missing`);
    if (!/^-?\d+$/.test(token) && !known.has(token)) console.warn(`${name}: unknown value ${token} (read as 0)`);
    return token;
  };
  const guides = (list: XmlElement | undefined): string =>
    all(list)
      .map((gd) => {
        const [op, ...args] = gd.attrs.fmla!.trim().split(/\s+/);
        args.forEach(check);
        known.add(gd.attrs.name!);
        return `${gd.attrs.name}=${[op, ...args].join(' ')}`;
      })
      .join(';');
  const adjustments = guides(child(shape, 'avLst'));
  const formulas = guides(child(shape, 'gdLst'));
  const rect = child(shape, 'rect');
  const text = rect ? ['l', 't', 'r', 'b'].map((k) => check(rect.attrs[k])).join(' ') : '';
  const paths = all(child(shape, 'pathLst')).map((p) => {
    const shade = SHADES[p.attrs.fill ?? 'norm'];
    if (shade === undefined) throw new Error(`${name}: fill ${p.attrs.fill}`);
    const size = p.attrs.w || p.attrs.h ? ` ${p.attrs.w ?? 0} ${p.attrs.h ?? 0}` : '';
    const tokens = all(p).flatMap((cmd) => {
      const letter = COMMANDS[local(cmd)];
      if (!letter) throw new Error(`${name}: ${cmd.name}`);
      const values = letter === 'A' ? ['wR', 'hR', 'stAng', 'swAng'].map((k) => cmd.attrs[k]) : all(cmd).flatMap((pt) => [pt.attrs.x, pt.attrs.y]);
      if (values.length !== VALUES[letter]) throw new Error(`${name}: ${local(cmd)} has ${values.length} values`);
      return [letter, ...values.map(check)];
    });
    return `${/^(0|false)$/.test(p.attrs.stroke ?? '') ? 'n' : ''}${shade}${size}:${tokens.join(' ')}`;
  });
  const line = [name, adjustments, formulas, text, paths.join('|')].join('\t');
  if (lines.has(name) && lines.get(name) !== line) console.warn(`${name}: defined twice, differently; the first is kept`);
  else lines.set(name, line);
}

// The standard's file has upDownArrow twice and no upArrow (a slip in the standard): it is downArrow the other way up.
if (!lines.has('upArrow')) {
  const guides = 'maxAdj2=*/ 100000 h ss;a1=pin 0 adj1 100000;a2=pin 0 adj2 maxAdj2;dy2=*/ ss a2 100000;y2=+- t dy2 0;dx1=*/ w a1 200000;x1=+- hc 0 dx1;x2=+- hc dx1 0;dy1=*/ x1 dy2 wd2;y1=+- y2 0 dy1';
  lines.set('upArrow', ['upArrow', 'adj1=val 50000;adj2=val 50000', guides, 'x1 y1 x2 b', ':M l y2 L hc t L r y2 L x2 y2 L x2 b L x1 b L x1 y2 Z'].join('\t'));
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../client/src/drawingml/presetData.ts');
const body = [...lines.values()].join('\n');
if (/[`\\$]/.test(body)) throw new Error('a value would need escaping');
writeFileSync(
  out,
  `// Generated by scripts/preset-shapes.ts from ECMA-376's presetShapeDefinitions.xml; don't edit. The format is described there.\n\nexport const PRESET_DATA = \`${body}\`;\n`,
);
console.log(`${lines.size} shapes, ${Math.round(body.length / 1024)} kB`);
