// Vector drawings (SVG and compressed SVG, .svgz): reading a file makes a one-page document showing
// it, with the drawing kept as SVG text in the document's extension (see vectorDoc.ts); writing gives
// the drawing back (a document that isn't one is drawn as vector graphics, see svgFromDocument.ts).
// Loaded when a drawing is opened, saved or exported.

import type { WordDocument } from '@golemdocs/docx';
import { documentToSvg } from '../svgFromDocument.ts';
import { sceneToDocument, svgBytes, svgOfDocument, svgText } from '../vectorDoc.ts';
import type { Extensions } from '../wdoc.ts';
import { objectsToScene } from '../../vector/nodes.ts';
import { SvgError } from '../../vector/svgRead.ts';
import { writeSvg } from '../../vector/svgWrite.ts';
import { t } from '../../i18n/index.ts';
import type { FormatHandler } from '../convert.ts';

function handler(compressed: boolean): FormatHandler {
  return {
    async read(bytes) {
      try {
        const { text, scene, gzip } = await svgText(bytes);
        return await sceneToDocument(scene, text, gzip);
      } catch (e) {
        if (e instanceof SvgError) throw new Error(t('app.notSvg'));
        throw e;
      }
    },
    async write(document, extensions, fonts) {
      return svgBytes(extensions.svg ? extensions.svg.source : await documentToSvg(document, fonts), compressed);
    },
  };
}

export const svg = handler(false);
export const svgz = handler(true);

/** A drawing's extensions with its SVG text as the document has it now (see `withDrawingText` in ../drawingText.ts). */
export async function drawingText(document: WordDocument, extensions: Extensions): Promise<Extensions> {
  // A drawing edited together is its objects (a room writes only those): the SVG is made from them.
  const vec = extensions.vec;
  if (vec?.meta[0]) return { ...extensions, svg: { ...extensions.svg, source: writeSvg(objectsToScene({ meta: vec.meta[0], nodes: vec.nodes, defs: vec.defs })) } };
  const text = await svgOfDocument(document).catch(() => null);
  return text === null ? extensions : { ...extensions, svg: { ...extensions.svg, source: text } };
}
