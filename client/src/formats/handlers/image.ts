// The picture formats (PNG, JPEG, WebP): reading a picture file makes a one-page document showing it;
// writing takes a picture document's picture back out (converted when it is another type) and draws any other document's pages. Loaded when a
// picture is opened, saved or exported.

import { transcode } from '../imageCodec.ts';
import type { OutputType } from '../imageCodec.ts';
import { documentToImage } from '../pageImage.ts';
import { firstPicture, imageToDocument, isPictureDocument } from '../imageDoc.ts';
import { sniffImage } from '../images.ts';
import { t } from '../../i18n/index.ts';
import type { FormatHandler } from '../convert.ts';

function handler(type: OutputType): FormatHandler {
  return {
    async read(bytes) {
      const image = sniffImage(bytes);
      if (!image) throw new Error(t('app.notImage'));
      return { document: await imageToDocument(image), extensions: {} };
    },
    async write(document, _extensions, fonts) {
      // A picture's own page gives the picture back untouched; any other document is drawn.
      const picture = (await isPictureDocument(document)) ? await firstPicture(document) : null;
      return picture ? transcode(picture.image.bytes, type) : documentToImage(document, fonts, type);
    },
  };
}

export const png = handler('png');
export const jpeg = handler('jpeg');
export const webp = handler('webp');
