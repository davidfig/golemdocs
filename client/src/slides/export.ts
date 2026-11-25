// A deck written out (docs/slides.md): its slides as a vector PDF (a page per slide, through the drawing editor's PDF writer),
// as SVG, and a slide's scene with its pictures inside it (data: URIs), which is what those writers and a live block need.

import type { GroupNode, Scene, SceneNode } from '../vector/model.ts';
import { scenesToPdf } from '../vector/pdfOut.ts';
import type { Deck } from './deck.ts';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/** A copy of a scene whose pictures (`pptx:<part>`) are data: URIs. */
export async function sceneWithData(scene: Scene, deck: Deck): Promise<Scene> {
  const cache = new Map<string, string>();
  const convert = async (nodes: readonly SceneNode[]): Promise<SceneNode[]> => {
    const out: SceneNode[] = [];
    for (const node of nodes) {
      if (node.kind === 'group') out.push({ ...(node as GroupNode), children: await convert(node.children) });
      else if (node.kind === 'image' && node.href.startsWith('pptx:')) {
        const part = node.href.slice(5);
        let href = cache.get(part);
        if (href === undefined) {
          const ext = part.slice(part.lastIndexOf('.') + 1).toLowerCase();
          const mime = MIME[ext];
          href = mime ? `data:${mime};base64,${base64(await deck.bytes(part).catch(() => new Uint8Array(0)))}` : '';
          cache.set(part, href);
        }
        if (href) out.push({ ...node, href });
      } else out.push(node);
    }
    return out;
  };
  return { ...scene, children: await convert(scene.children) };
}

/** Slides' scenes as a PDF, a page each. */
export function deckPdf(scenes: readonly Scene[], title: string): Promise<Uint8Array> {
  return scenesToPdf(scenes, title);
}
