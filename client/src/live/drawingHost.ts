// A drawing as a live block's host (docs/live-blocks.md §3): a group (`<g data-golem-live="Budget.xlsx#chart:Spending"
// data-golem-stamp="…">`) holding the block's result, drawn as a picture or as text. The group is an ordinary part of the
// drawing: moved, scaled and styled in the drawing editor like any other, and other programs show what it holds.
//
// An update replaces what the group shows and nothing around it: a picture keeps the box it was given (only its bytes
// change), text keeps its place and style (only its lines change). A new group (a live link pasted into a drawing) takes the
// result's own size, at the drawing's top left, to be moved where it should go.

import { paragraphText, paragraphsIn } from '@golemdocs/docx';
import type { GroupNode, ImageNode, Scene, SceneNode, TextNode } from '../vector/model.ts';
import { isWdoc, readWdoc } from '../formats/wdoc.ts';
import type { LiveResult } from './result.ts';
import { resultOf, stampOf } from './sources.ts';
import type { SourceLookup } from './sources.ts';
import type { UpdateReport } from './update.ts';

export const LIVE_ATTR = 'data-golem-live';
export const STAMP_ATTR = 'data-golem-stamp';

/** The live groups of a drawing, at any depth. */
export function drawingLiveGroups(nodes: readonly SceneNode[]): GroupNode[] {
  const out: GroupNode[] = [];
  for (const node of nodes) {
    if (node.kind !== 'group') continue;
    if (node.attrs[LIVE_ATTR] !== undefined) out.push(node);
    else out.push(...drawingLiveGroups(node.children));
  }
  return out;
}

/** The sources a drawing's live groups show. */
export const drawingLiveSources = (svg: string): string[] => [...new Set([...svg.matchAll(/data-golem-live="([^"]*)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')))];

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A result as lines of text; null when it is a picture. */
function linesOf(result: LiveResult): string[] | null {
  if (result.kind === 'value') return result.text.split('\n');
  if (result.kind === 'table') return result.rows.map((r) => r.join('    '));
  if (result.kind === 'blocks') return paragraphsIn(result.blocks).map(paragraphText);
  return null;
}

const first = <K extends SceneNode['kind']>(group: GroupNode, kind: K): Extract<SceneNode, { kind: K }> | undefined =>
  group.children.find((c): c is Extract<SceneNode, { kind: K }> => c.kind === kind);

/** Puts a result in a live group, keeping the box or the place and style of what it showed before. */
export function fillGroup(group: GroupNode, result: LiveResult, stamp: string): boolean {
  if (result.kind === 'picture') {
    const old = first(group, 'image');
    const href = result.svg ? `data:image/svg+xml;base64,${base64(new TextEncoder().encode(result.svg))}` : `data:image/png;base64,${base64(result.bytes)}`;
    const image: ImageNode = old ? { ...old, href } : { kind: 'image', x: 0, y: 0, width: result.width, height: result.height, href, style: {}, attrs: {} };
    group.children = [image];
  } else {
    const lines = linesOf(result);
    if (!lines) return false;
    const old = first(group, 'text');
    const size = parseFloat(old?.style['font-size'] ?? '') || 16;
    const base: TextNode = old ?? { kind: 'text', x: 0, y: size, runs: [], style: { 'font-size': `${size}px`, 'font-family': 'sans-serif' }, attrs: {} };
    // A line each: the first where the text was, each next one a line lower.
    const runs = lines.map((text, i) => ({ text, x: base.x, ...(i === 0 ? { y: base.y } : { dy: size * 1.25 }), style: {} }));
    group.children = [{ ...base, runs }];
  }
  group.attrs = { ...group.attrs, [STAMP_ATTR]: stamp };
  return true;
}

/** Brings a drawing's live groups up to date, in place; what happened to each. */
export async function updateSceneLive(scene: Scene, lookup: SourceLookup, options: { force?: boolean } = {}): Promise<UpdateReport> {
  const report: UpdateReport = { updated: 0, problems: [] };
  const files = new Map<string, ReturnType<SourceLookup>>();
  const results = new Map<string, Promise<LiveResult>>();
  for (const group of drawingLiveGroups(scene.children)) {
    const source = group.attrs[LIVE_ATTR];
    let found = results.get(source);
    if (!found) results.set(source, (found = resultOf(source, lookup, files)));
    const result = await found;
    if (result.kind === 'error') {
      report.problems.push({ source, code: result.code, ...(result.detail !== undefined && { detail: result.detail }) });
      continue;
    }
    const stamp = stampOf(result);
    if (stamp === group.attrs[STAMP_ATTR] && !options.force) continue;
    if (fillGroup(group, result, stamp)) report.updated++;
    else report.problems.push({ source, code: 'unsupported' });
  }
  return report;
}

/** A new live group showing `source`, to be filled by the next update. */
export const liveGroup = (source: string): GroupNode => ({ kind: 'group', tag: 'g', children: [], style: {}, attrs: { [LIVE_ATTR]: source } });

/** A stored drawing's bytes with its live groups up to date (null when none changed, or it has none). */
export async function updateStoredDrawing(bytes: Uint8Array, lookup: SourceLookup, options: { force?: boolean } = {}): Promise<{ bytes: Uint8Array | null; report: UpdateReport }> {
  const none = { bytes: null, report: { updated: 0, problems: [] } };
  const wdoc = isWdoc(bytes);
  // An SVG file kept as it was uploaded (written by an agent, say) is updated as the file it is.
  const source = wdoc ? (await readWdoc(bytes)).extensions.svg?.source : new TextDecoder().decode(bytes);
  if (!source?.includes(LIVE_ATTR)) return none;
  // The SVG reader and writer come with the drawing editor's chunks.
  const [{ readSvg }, { writeSvg }] = await Promise.all([import('../vector/svgRead.ts'), import('../vector/svgWrite.ts')]);
  const scene = readSvg(source);
  const report = await updateSceneLive(scene, lookup, options);
  if (!report.updated) return { bytes: null, report };
  const svg = writeSvg(scene);
  if (!wdoc) return { bytes: new TextEncoder().encode(svg), report };
  // The drawing's picture is made again with the SVG (the drawing reader and painter come with the drawing editor's chunk).
  const { rewriteStoredDrawing } = await import('../formats/vectorDoc.ts');
  return { bytes: await rewriteStoredDrawing(bytes, svg), report };
}
