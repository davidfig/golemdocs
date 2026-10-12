// The part of libheif-js (no types of its own) that heicDecode.ts uses.

export interface HeifImage {
  get_width(): number;
  get_height(): number;
  is_primary?(): boolean;
  /** Fills `target` with RGBA pixels; the callback gets it back, or null when decoding failed. */
  display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (result: unknown) => void): void;
  free?(): void;
}

export interface Libheif {
  HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] };
}
