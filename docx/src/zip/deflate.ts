// SPDX-License-Identifier: MIT
// Raw DEFLATE via the platform's Compression Streams API (browsers and Node 18+).

type ByteTransform = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

function stream(data: Uint8Array, transform: ByteTransform): ReadableStream<Uint8Array> {
  return new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform);
}

/**
 * Inflates `data`, which must come out at exactly `size` bytes. Output is never allowed past
 * `size`, so an entry whose header understates its contents (a ZIP bomb) is cut off early
 * instead of exhausting memory.
 */
export async function inflateRaw(data: Uint8Array, size: number): Promise<Uint8Array> {
  const reader = stream(data, new DecompressionStream('deflate-raw') as unknown as ByteTransform).getReader();
  // Chunks rather than one buffer of `size`: the header's size isn't trusted for allocation either.
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > size) {
      await reader.cancel();
      throw new RangeError(`inflates past its declared size of ${size} bytes`);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream(data, new CompressionStream('deflate-raw') as unknown as ByteTransform)).arrayBuffer());
}
