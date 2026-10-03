// Vector drawings (SVG and compressed SVG, .svgz): reading a file makes a one-page document showing
// it, with the drawing kept as SVG text in the document's extension (see vectorDoc.ts); writing gives
// the drawing back (a document that isn't one is drawn as vector graphics, see svgFromDocument.ts).
// Loaded when a drawing is opened, saved or exported.

import { documentToSvg } from '../svgFromDocument.ts';
import { sceneToDocument, svgBytes, svgText } from '../vectorDoc.ts';
import { SvgError } from '../../vector/svgRead.ts';
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
