// An edited large text file is kept in the account like any document, comes back from it as the large-text editor (never as a
// Word document, and never in a room), and one over the server's limit stays in this browser with a message.

import { test, expect } from '../fixtures';
import { importFile } from '../files/helpers';
import { clickAt, expectLine, largeStatus, state, statusBarOn, viewer as textViewer } from '../files/large-helpers';
import { newPerson, waitForCloudDoc } from './helpers';

// The file is sent to the server in one request, and a trace would keep a copy of its body.
test.use({ trace: 'off' });

const LINES = 150_000;
const BIG = Buffer.from(Array.from({ length: LINES }, (_, i) => `Line ${i + 1} the quick brown fox jumps over the lazy dog ${'.'.repeat(12)}`).join('\n') + '\n', 'utf8');

test('an edited large file is uploaded and opens again from the account in the large-text editor', async ({ browser }) => {
  const person = await newPerson(browser, 'large');
  await statusBarOn(person.context);
  const { page } = person;
  await page.goto('/?doc=welcome');
  await person.app.ready();
  await importFile(person.app, { name: 'big.txt', buffer: BIG });
  const viewer = textViewer(page);
  await expect(viewer).toBeVisible();
  await expect(largeStatus(page)).toContainText(`${LINES.toLocaleString('en-US')} lines`, { timeout: 30_000 });
  await expect.poll(async () => (await state(page)).glyphs, { timeout: 15_000 }).toBeGreaterThan(0);
  await clickAt(page, 1, 0);
  await page.keyboard.type('CLOUD ');
  await expect(page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 60_000 });
  const doc = await waitForCloudDoc(page);
  expect(doc.name).toBe('big.txt');
  await expect.poll(async () => (await waitForCloudDoc(page)).size, { timeout: 30_000 }).toBe(BIG.length + 6);
  // A second edit: the document goes up as chunks, and only the one or two that changed are sent.
  const uploads: { method: string; type: string; bytes: number }[] = [];
  page.on('request', (request) => {
    if (/\/api\/documents\/[^/?]+(\?|$)/.test(request.url()) && request.method() === 'PUT') uploads.push({ method: 'PUT', type: request.headers()['content-type'] ?? '', bytes: Number(request.headers()['content-length'] ?? 0) });
  });
  await clickAt(page, 5, 0);
  await page.keyboard.type('SECOND ');
  await expect.poll(async () => (await waitForCloudDoc(page)).size, { timeout: 60_000 }).toBe(BIG.length + 13);
  expect(uploads.length).toBeGreaterThanOrEqual(1);
  expect(uploads.at(-1)!.type).toBe('application/vnd.golemdocs.delta');
  expect(uploads.at(-1)!.bytes, `the second save sent ${uploads.at(-1)!.bytes} bytes of a ${BIG.length} byte file`).toBeLessThan(3_000_000);
  // From the account, in a fresh page: the large-text editor with the edit, not a document.
  await page.goto(`/?doc=cloud:${doc.id}`);
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  await expect(largeStatus(page)).toContainText(`${LINES.toLocaleString('en-US')} lines`, { timeout: 30_000 });
  await expectLine(page, 1, /^CLOUD Line 2 the quick/);
  await expectLine(page, 5, /^SECOND Line 6 the quick/);
  // Nothing wrote the file back as a room would (it would be a different size, or a Word file).
  await page.waitForTimeout(2000);
  expect((await waitForCloudDoc(page)).size).toBe(BIG.length + 13);
  await person.context.close();
});
