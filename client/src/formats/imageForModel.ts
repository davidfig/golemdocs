// A picture as the assistant's model is sent it: a `data:` URI of a picture small enough for the
// server to take (server/src/assistant.ts), scaled down to what a model can use. A picture that
// already fits goes as it is, so nothing is decoded or lost.

import { decodeImage, encodeCanvas, makeCanvas } from './imageCodec.ts';
import { sniffImage, toDataUri } from './images.ts';

/** The longest side a model is shown: more pixels only cost more. */
export const MODEL_LONGEST_SIDE = 1568;
/** The longest data URI the server takes. */
export const MODEL_MAX_URI_CHARS = 1_400_000;

/** The size a picture is shown at: scaled to fit `limit` on its longest side, never enlarged. */
export function fitSize(width: number, height: number, limit = MODEL_LONGEST_SIDE): { width: number; height: number } {
  const scale = Math.min(1, limit / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether a picture can go as it is: a type the model reads, not too many pixels, not too many bytes. */
function fits(bytes: Uint8Array, width: number, height: number): boolean {
  return width > 0 && height > 0 && Math.max(width, height) <= MODEL_LONGEST_SIDE && Math.ceil((bytes.length * 4) / 3) + 40 <= MODEL_MAX_URI_CHARS;
}

/** The picture as a data URI for the model. Throws when the bytes are not a picture (or it cannot be made small enough). */
export async function pictureForModel(bytes: Uint8Array): Promise<string> {
  const image = sniffImage(bytes);
  if (!image) throw new Error('not a picture');
  if ((image.type === 'png' || image.type === 'jpeg' || image.type === 'webp' || image.type === 'gif') && fits(bytes, image.width, image.height)) return toDataUri(image);
  // Re-encode as JPEG (a BMP or a big picture), a little smaller each time until it fits.
  const bitmap = await decodeImage(bytes, image.type);
  try {
    let side = MODEL_LONGEST_SIDE;
    for (let quality = 0.85; ; quality -= 0.15, side = Math.round(side * 0.75)) {
      const size = fitSize(bitmap.width, bitmap.height, side);
      const { canvas, context } = makeCanvas(size.width, size.height);
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      const jpeg = await encodeCanvas(canvas, 'jpeg', Math.max(quality, 0.4));
      const uri = toDataUri({ bytes: jpeg, type: 'jpeg', width: size.width, height: size.height });
      if (uri.length <= MODEL_MAX_URI_CHARS) return uri;
      if (side < 256) throw new Error('the picture could not be made small enough');
    }
  } finally {
    bitmap.close();
  }
}
