// CRC-32 (IEEE 802.3, as used by ZIP), slicing-by-8: ~8 bytes per table round.

const TABLES = (() => {
  const tables = new Uint32Array(256 * 8);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tables[i] = c;
  }
  for (let i = 0; i < 256; i++) {
    let c = tables[i];
    for (let t = 1; t < 8; t++) {
      c = tables[c & 0xff] ^ (c >>> 8);
      tables[t * 256 + i] = c;
    }
  }
  return tables;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  const t = TABLES;
  let c = ~crc >>> 0;
  let i = 0;
  const end8 = data.length - (data.length % 8);
  for (; i < end8; i += 8) {
    const a = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) ^ c;
    c =
      t[7 * 256 + (a & 0xff)] ^
      t[6 * 256 + ((a >>> 8) & 0xff)] ^
      t[5 * 256 + ((a >>> 16) & 0xff)] ^
      t[4 * 256 + (a >>> 24)] ^
      t[3 * 256 + data[i + 4]] ^
      t[2 * 256 + data[i + 5]] ^
      t[256 + data[i + 6]] ^
      t[data[i + 7]];
  }
  for (; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
