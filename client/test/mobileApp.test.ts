import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTouchDevice } from '../src/desktop/bridge.ts';

const nav = (userAgent: string, platform: string, maxTouchPoints = 0) => ({ userAgent, platform, maxTouchPoints });

describe('isTouchDevice', () => {
  it('knows a phone', () => {
    assert.equal(isTouchDevice(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X)', 'iPhone', 5)), true);
    assert.equal(isTouchDevice(nav('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 'Linux armv8l', 5)), true);
  });
  it('knows an iPad that reports itself as a Mac', () => {
    assert.equal(isTouchDevice(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)), true);
  });
  it('is not fooled by a desktop', () => {
    assert.equal(isTouchDevice(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)), false);
    assert.equal(isTouchDevice(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 10)), false);
  });
});
