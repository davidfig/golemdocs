import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { aesCbcDecrypt, aesCbcEncrypt, md5, rc4, sha256, sha384, sha512 } from '../src/crypt/primitives.ts';
import { saslprep } from '../src/crypt/standard.ts';
import { ascii } from './helpers.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
// Lengths around every padding boundary of 64- and 128-byte blocks.
const SIZES = [0, 1, 3, 55, 56, 57, 63, 64, 65, 111, 112, 113, 127, 128, 129, 1000, 4099];

for (const [name, ours] of [
  ['md5', md5],
  ['sha256', sha256],
  ['sha384', sha384],
  ['sha512', sha512],
] as const) {
  test(`${name} matches node:crypto`, () => {
    for (const n of SIZES) {
      const data = new Uint8Array(randomBytes(n));
      assert.equal(hex(ours(data)), createHash(name).update(data).digest('hex'), `length ${n}`);
    }
  });
}

test('rc4 test vectors', () => {
  assert.equal(hex(rc4(ascii('Key'), ascii('Plaintext'))), 'bbf316e8d940af0ad3');
  assert.equal(hex(rc4(ascii('Wiki'), ascii('pedia'))), '1021bf0420');
  assert.equal(hex(rc4(ascii('Secret'), ascii('Attack at dawn'))), '45a01f645fc35b383552544b9bf5');
});

for (const bits of [128, 192, 256]) {
  test(`aes-${bits}-cbc matches node:crypto`, () => {
    for (const n of [16, 32, 160, 4096]) {
      const key = new Uint8Array(randomBytes(bits / 8));
      const iv = new Uint8Array(randomBytes(16));
      const data = new Uint8Array(randomBytes(n));
      const theirs = createCipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(false);
      const expected = Buffer.concat([theirs.update(data), theirs.final()]);
      assert.equal(hex(aesCbcEncrypt(key, iv, data)), expected.toString('hex'));
      assert.equal(hex(aesCbcDecrypt(key, iv, expected, false)), hex(data));
    }
  });
}

test('aes decryption strips PKCS#5 padding', () => {
  const key = new Uint8Array(randomBytes(16));
  const iv = new Uint8Array(randomBytes(16));
  for (const n of [0, 1, 15, 16, 17]) {
    const data = new Uint8Array(randomBytes(n));
    const c = createCipheriv('aes-128-cbc', key, iv);
    const enc = Buffer.concat([c.update(data), c.final()]);
    assert.equal(hex(aesCbcDecrypt(key, iv, enc)), hex(data));
  }
});

test('saslprep maps and normalizes passwords', () => {
  assert.equal(saslprep('SªSL­prep'), 'SaSLprep');
  assert.equal(saslprep('a b'), 'a b');
  assert.equal(saslprep('Ⅸ'), 'IX');
});
