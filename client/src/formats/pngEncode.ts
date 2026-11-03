// A PNG of RGBA pixels, written here rather than by a canvas. A canvas gives its PNG as a Blob, and WebKit can't read a Blob in a
// worker with an opaque origin (the embeddable viewer's, in a sandboxed frame; see docs/architecture/viewer.md): so there, a drawing's
// picture is encoded from its pixels instead. The compression is the platform's (`CompressionStream`), fed through a writer, never a
// Blob.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;

/** CRC-32 (the PNG and zlib polynomial) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** zlib-compressed bytes (what a PNG's image data is), through a stream writer so that no Blob is read. */
async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const parts: Uint8Array[] = [];
  let length = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGBA PNG of `pixels` (unpremultiplied, rows top first, as `getImageData` gives them), each row unfiltered. */
export async function encodePng(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  const row = width * 4;
  const raw = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', header), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
