// Decoding HEIC (Apple's photo format) in software, for the browsers that can't (everything but Safari,
// and Chrome on some systems). It is libheif compiled to WebAssembly, with the wasm inside the module,
// so this is one lazily loaded chunk of over a megabyte that is fetched only when a HEIC picture is
// opened on such a browser: `decodeImage` (imageCodec.ts) tries the browser's own decoder first and
// only then does `import()` this. Never import this module statically.

// @ts-expect-error libheif-js has no type declarations (see libheifTypes.ts for the part used here).
import * as loaded from 'libheif-js/wasm-bundle.js';
import type { Libheif } from './libheifTypes.ts';

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, rows top to bottom, a quarter turn or mirror in the file already applied. */
  data: Uint8ClampedArray;
}

let library: Promise<Libheif> | undefined;

/** The decoder, set up once. The package is CommonJS (`default` holds it under a bundler) and some builds export a function that makes it. */
function libheif(): Promise<Libheif> {
  library ??= (async () => {
    const module = (loaded as { default?: unknown }).default ?? loaded;
    return (typeof module === 'function' ? await (module as () => Promise<Libheif>)() : module) as Libheif;
  })();
  return library;
}

/** The pixels of a HEIC file's main picture. Throws when the file can't be decoded. */
export async function decodeHeicPixels(bytes: Uint8Array): Promise<Pixels> {
  const decoder = new (await libheif()).HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images.length) throw new Error('no picture in this HEIC file');
  const image = images.find((candidate) => candidate.is_primary?.()) ?? images[0];
  try {
    const width = image.get_width();
    const height = image.get_height();
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
    await new Promise<void>((resolve, reject) => image.display(target, (done) => (done ? resolve() : reject(new Error('this HEIC picture could not be decoded')))));
    return target;
  } finally {
    for (const each of images) each.free?.();
  }
}

/** A HEIC file's main picture as a bitmap, like the browser's own decoder gives. */
export async function decodeHeicBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const { width, height, data } = await decodeHeicPixels(bytes);
  return createImageBitmap(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height));
}
