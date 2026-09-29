// The OLE2 "Compound File Binary" container that Word 97-2003 (.doc), and other legacy Office
// files, live in: a small file system of named streams, stored in fixed-size sectors chained
// through a table (the FAT). Streams under 4 KB live in a second, finer-grained "mini" stream.
// Read-only; only what finding and reading streams needs.

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const MAX_REGULAR = 0xfffffffa;

export class CfbError extends Error {}

interface Entry {
  name: string;
  type: number;
  start: number;
  size: number;
}

export function isCfb(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
}

export class Cfb {
  private readonly view: DataView;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniCutoff: number;
  private fat: Uint32Array = new Uint32Array(0);
  private miniFat: Uint32Array = new Uint32Array(0);
  private miniStream: Uint8Array = new Uint8Array(0);
  private readonly entries: Entry[] = [];

  constructor(private readonly bytes: Uint8Array) {
    if (!isCfb(bytes)) throw new CfbError('not a compound file');
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.view;
    this.sectorSize = 1 << v.getUint16(30, true);
    this.miniSectorSize = 1 << v.getUint16(32, true);
    this.miniCutoff = v.getUint32(56, true);
    if (this.sectorSize !== 512 && this.sectorSize !== 4096) throw new CfbError('unsupported sector size');

    // The FAT: its sectors are listed in the header (109 of them) and in a chain of DIFAT sectors.
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i++) {
      const s = v.getUint32(76 + i * 4, true);
      if (s <= MAX_REGULAR) fatSectors.push(s);
    }
    let difat = v.getUint32(68, true);
    for (let guard = 0; difat <= MAX_REGULAR && guard < 10000; guard++) {
      const base = this.offset(difat);
      const per = this.sectorSize / 4 - 1;
      for (let i = 0; i < per; i++) {
        const s = this.u32(base + i * 4);
        if (s <= MAX_REGULAR) fatSectors.push(s);
      }
      difat = this.u32(base + per * 4);
    }
    const perFat = this.sectorSize / 4;
    this.fat = new Uint32Array(fatSectors.length * perFat);
    fatSectors.forEach((s, k) => {
      const base = this.offset(s);
      for (let i = 0; i < perFat; i++) this.fat[k * perFat + i] = this.u32(base + i * 4);
    });

    // Directory.
    const directory = this.chain(v.getUint32(48, true));
    for (let k = 0; k < directory.length; k++) {
      const base = this.offset(directory[k]);
      for (let e = 0; e < this.sectorSize / 128; e++) {
        const at = base + e * 128;
        const nameLength = Math.min(this.view.getUint16(at + 64, true), 64);
        let name = '';
        for (let c = 0; c + 2 <= nameLength - 2; c += 2) name += String.fromCharCode(this.view.getUint16(at + c, true));
        this.entries.push({
          name,
          type: bytes[at + 66],
          start: this.u32(at + 116),
          size: this.u32(at + 120) + (this.sectorSize === 4096 ? this.u32(at + 124) * 0x100000000 : 0),
        });
      }
    }

    // The mini stream is the root entry's data; the mini FAT indexes it.
    const root = this.entries[0];
    if (root?.type === 5) {
      this.miniStream = this.readChain(root.start, root.size);
      const miniFatSectors = this.chain(v.getUint32(60, true));
      const mini = new Uint32Array((miniFatSectors.length * this.sectorSize) / 4);
      miniFatSectors.forEach((s, k) => {
        const base = this.offset(s);
        for (let i = 0; i < perFat; i++) mini[k * perFat + i] = this.u32(base + i * 4);
      });
      this.miniFat = mini;
    }
  }

  private u32(at: number): number {
    if (at < 0 || at + 4 > this.bytes.length) throw new CfbError('the file is truncated');
    return this.view.getUint32(at, true);
  }

  private offset(sector: number): number {
    return (sector + 1) * this.sectorSize;
  }

  /** The sectors of a chain, from `first`. */
  private chain(first: number): number[] {
    const out: number[] = [];
    let s = first;
    while (s <= MAX_REGULAR && s !== END_OF_CHAIN && s !== FREE) {
      if (out.length > this.fat.length) throw new CfbError('the file has a loop in its sector table');
      out.push(s);
      s = this.fat[s] ?? END_OF_CHAIN;
    }
    return out;
  }

  private readChain(first: number, size: number): Uint8Array {
    if (size > this.bytes.length) throw new CfbError('a stream is larger than the file');
    const sectors = this.chain(first);
    const out = new Uint8Array(size);
    let written = 0;
    for (const s of sectors) {
      const from = this.offset(s);
      if (from >= this.bytes.length) break;
      const part = this.bytes.subarray(from, Math.min(from + this.sectorSize, this.bytes.length));
      const n = Math.min(part.length, size - written);
      out.set(part.subarray(0, n), written);
      written += n;
      if (written >= size) break;
    }
    return out;
  }

  private readMini(first: number, size: number): Uint8Array {
    if (size > this.miniStream.length) throw new CfbError('a stream is larger than the file');
    const out = new Uint8Array(size);
    let written = 0;
    let s = first;
    for (let guard = 0; s <= MAX_REGULAR && written < size && guard <= this.miniFat.length; guard++) {
      const from = s * this.miniSectorSize;
      const n = Math.min(this.miniSectorSize, size - written);
      out.set(this.miniStream.subarray(from, from + n), written);
      written += n;
      s = this.miniFat[s] ?? END_OF_CHAIN;
    }
    return out;
  }

  /** A stream's bytes by name (top-level streams only), or null when there is none. */
  stream(name: string): Uint8Array | null {
    const entry = this.entries.find((e) => e.type === 2 && e.name === name);
    if (!entry) return null;
    return entry.size < this.miniCutoff ? this.readMini(entry.start, entry.size) : this.readChain(entry.start, entry.size);
  }
}
