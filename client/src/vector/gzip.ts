// gzip, for compressed SVG (.svgz), with the browser's own streams.

/** Whether bytes start with the gzip signature. */
export const isGzip = (bytes: Uint8Array): boolean => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

async function run(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export const gzip = (bytes: Uint8Array): Promise<Uint8Array> => run(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes: Uint8Array): Promise<Uint8Array> => run(bytes, new DecompressionStream('gzip'));
