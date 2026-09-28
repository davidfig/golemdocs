// Raw DEFLATE via the platform's Compression Streams API (browsers and Node 18+).

type ByteTransform = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

async function pipe(data: Uint8Array, transform: ByteTransform): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('deflate-raw') as unknown as ByteTransform);
}

export function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate-raw') as unknown as ByteTransform);
}
