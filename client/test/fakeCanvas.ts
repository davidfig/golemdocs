// A recording stand-in for the browser's canvas and image decoder, so code that draws (imageCodec.ts,
// pageImage.ts) can run in Node. It keeps every drawing call, in order, for tests to read.

export interface Call {
  op: string;
  args: unknown[];
  /** fillStyle / font at the time of the call. */
  fillStyle?: unknown;
  font?: unknown;
}

export class FakeContext {
  calls: Call[] = [];
  fillStyle: unknown = '#000';
  font = '10px sans-serif';
  textBaseline = '';
  constructor(readonly canvas: FakeCanvas) {}
  private record(op: string, args: unknown[]) {
    this.calls.push({ op, args, fillStyle: this.fillStyle, font: this.font });
  }
  save = (...a: unknown[]) => this.record('save', a);
  restore = (...a: unknown[]) => this.record('restore', a);
  translate = (...a: unknown[]) => this.record('translate', a);
  scale = (...a: unknown[]) => this.record('scale', a);
  beginPath = (...a: unknown[]) => this.record('beginPath', a);
  rect = (...a: unknown[]) => this.record('rect', a);
  clip = (...a: unknown[]) => this.record('clip', a);
  fillRect = (...a: unknown[]) => this.record('fillRect', a);
  fillText = (...a: unknown[]) => this.record('fillText', a);
  drawImage = (...a: unknown[]) => this.record('drawImage', a);
  fill = (...a: unknown[]) => this.record('fill', a);
  ops = (op: string) => this.calls.filter((c) => c.op === op);
}

export class FakeCanvas {
  static made: FakeCanvas[] = [];
  static noContext = false;
  /** What convertToBlob yields (null: the browser can't encode that type). */
  static blob: (options: { type: string; quality: number }) => Blob | null = (o) => new Blob([`encoded:${o.type}`], { type: o.type });
  ctx = new FakeContext(this);
  contextOptions: unknown;
  encoded: { type: string; quality: number }[] = [];
  constructor(
    public width: number,
    public height: number,
  ) {
    FakeCanvas.made.push(this);
  }
  getContext(_kind: string, options?: unknown) {
    this.contextOptions = options;
    return FakeCanvas.noContext ? null : this.ctx;
  }
  async convertToBlob(options: { type: string; quality: number }) {
    this.encoded.push(options);
    return FakeCanvas.blob(options);
  }
}

export interface FakeBitmap {
  width: number;
  height: number;
  closed: boolean;
  close(): void;
  blob: Blob;
}

/** Installs OffscreenCanvas and createImageBitmap on globalThis; returns what happened and an uninstaller. */
export function installFakeCanvas(decode: (blob: Blob) => { width: number; height: number } | null = () => ({ width: 7, height: 5 })) {
  const g = globalThis as Record<string, unknown>;
  const saved = { OffscreenCanvas: g.OffscreenCanvas, createImageBitmap: g.createImageBitmap };
  FakeCanvas.made = [];
  FakeCanvas.noContext = false;
  const bitmaps: FakeBitmap[] = [];
  g.OffscreenCanvas = FakeCanvas;
  g.createImageBitmap = async (blob: Blob) => {
    const size = decode(blob);
    if (!size) throw new Error('cannot decode');
    const bitmap: FakeBitmap = { ...size, closed: false, blob, close: () => void (bitmap.closed = true) };
    bitmaps.push(bitmap);
    return bitmap;
  };
  return {
    canvases: FakeCanvas.made,
    bitmaps,
    restore() {
      g.OffscreenCanvas = saved.OffscreenCanvas;
      g.createImageBitmap = saved.createImageBitmap;
      FakeCanvas.blob = (o) => new Blob([`encoded:${o.type}`], { type: o.type });
      FakeCanvas.noContext = false;
    },
  };
}
