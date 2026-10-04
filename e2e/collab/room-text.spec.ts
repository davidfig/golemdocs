// A big text file edited together: two devices of one account open the same cloud file in the large-text editor, type in different
// lines at once and see each other's changes, and undo takes back only one's own.

import { test, expect } from '../fixtures';
import { clickAt, expectLine, largeStatus, state, statusBarOn, viewer } from '../files/large-helpers';
import { expectPeople, newPerson, openCloud, signInAs, uploadDoc } from './helpers';

test.use({ trace: 'off' });

const LINES = 150_000;
const BIG = Buffer.from(Array.from({ length: LINES }, (_, i) => `Line ${i + 1} the quick brown fox jumps over the lazy dog ${'.'.repeat(12)}`).join('\n') + '\n', 'utf8');

test('two devices edit a big text file together and undo only their own changes', async ({ browser }) => {
  const a = await newPerson(browser, 'text');
  await statusBarOn(a.context);
  const doc = await uploadDoc(a.page, 'big.txt', BIG);
  const context = await browser.newContext();
  await statusBarOn(context);
  await signInAs(context, a.email);
  const pageB = await context.newPage();
  for (const page of [a.page, pageB]) {
    await openCloud(page, doc.id);
    await expect(viewer(page)).toBeVisible({ timeout: 60_000 });
    await expect(largeStatus(page)).toContainText(`${LINES.toLocaleString('en-US')} lines`, { timeout: 30_000 });
    await expect.poll(async () => (await state(page)).indexed, { timeout: 30_000 }).toBe(true);
  }
  await expectPeople(a.page, 2);
  await expectPeople(pageB, 2);

  await clickAt(a.page, 1, 0);
  await a.page.keyboard.type('AAA ');
  await clickAt(pageB, 3, 0);
  await pageB.keyboard.type('BBB ');
  for (const page of [a.page, pageB]) {
    await expectLine(page, 1, /^AAA Line 2 the quick/);
    await expectLine(page, 3, /^BBB Line 4 the quick/);
  }
  // Each sees where the other's caret is.
  await expect.poll(async () => (await state(a.page)).remotes.map((r) => r.line)).toEqual([3]);
  await expect.poll(async () => (await state(pageB)).remotes.map((r) => r.line)).toEqual([1]);
  // Both type in one line, one after the other: nothing is lost.
  await clickAt(a.page, 3, 0);
  await a.page.keyboard.type('ZZZ ');
  await expectLine(pageB, 3, /^ZZZ BBB Line 4 the quick/);

  // a undoes their own last change, not b's.
  await a.page.keyboard.press('ControlOrMeta+z');
  await expectLine(a.page, 3, /^BBB Line 4 the quick/);
  await expectLine(pageB, 3, /^BBB Line 4 the quick/);
  await expectLine(pageB, 1, /^AAA Line 2 the quick/);

  // The room writes the file itself, as it is.
  await expect.poll(async () => (await a.page.request.get(`/api/documents/${doc.id}`)).headers()['content-length'], { timeout: 30_000 }).toBe(String(BIG.length + 8));
  await context.close();
  await a.context.close();
});
