import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler, { apexUrl } from '../src/wwwRedirect.ts';

test('www goes to the same path and query on the bare domain, over https', () => {
  assert.equal(apexUrl('https://www.golemdocs.com/'), 'https://golemdocs.com/');
  assert.equal(apexUrl('http://www.golemdocs.com/home/de/?a=1#x'), 'https://golemdocs.com/home/de/?a=1#x');
});

test('the Worker answers with a 308 to the bare domain', async () => {
  const response = await (handler.fetch as (r: Request) => Response)(new Request('https://www.golemdocs.com/api/auth/x?y=2', { method: 'POST' }));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://golemdocs.com/api/auth/x?y=2');
});
