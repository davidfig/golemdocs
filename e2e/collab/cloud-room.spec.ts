// Live editing through the server's rooms (a Durable Object per cloud document). Two browser
// contexts signed in as the SAME account are two devices; both open the cloud copy and end up in
// the document's room. (A second, different account can't open a document shared with it yet:
// see share-people.spec.ts.)

import { test, expect, App, MOD } from '../fixtures';
import { addComment, cloudPair, commentTexts, commentsTitle, expectText, newPerson, openCloud, others, selectForward, signInAs, statusLine } from './helpers';

test.describe('a cloud document open on two devices', () => {
  test('the status line says who is here, and each device sees the other\'s caret under the account name', async ({ browser }) => {
    const { a, b } = await cloudPair(browser);
    await expect.poll(() => statusLine(a.page)).toContain('2 people here');
    await expect.poll(() => statusLine(b.page)).toContain('2 people here');
    const [seenByA] = await others(a.page);
    const [seenByB] = await others(b.page);
    expect(seenByA!.name).toBe(a.name);
    expect(seenByB!.name).toBe(a.name);
    expect(seenByA!.color).toBeGreaterThan(0);
    await b.context.close();
    await a.context.close();
  });

  test('typing on either device reaches the other', async ({ browser }) => {
    const { a, b } = await cloudPair(browser, ['Hello']);
    await expectText(a.app, 'Hello');
    await expectText(b.app, 'Hello');
    await a.app.type(' from A');
    await expectText(b.app, 'Hello from A');
    await b.app.press(`${MOD}+End`);
    await b.app.press('Enter');
    await b.app.type('B line');
    await expectText(a.app, 'Hello from A\nB line');
    await b.context.close();
    await a.context.close();
  });

  test('both typing at once converge and keep every character', async ({ browser }) => {
    const { a, b } = await cloudPair(browser, ['start', 'end']);
    await a.app.focus();
    await a.app.press(`${MOD}+Home`);
    await b.app.focus();
    await b.app.press(`${MOD}+End`);
    await Promise.all([a.page.keyboard.type('AAAA', { delay: 20 }), b.page.keyboard.type('BBBB', { delay: 20 })]);
    await expect.poll(async () => (await a.app.text()) === (await b.app.text()), { message: 'both devices hold the same text' }).toBe(true);
    expect(await a.app.text()).toBe('AAAAstart\nendBBBB');
    await b.context.close();
    await a.context.close();
  });

  test('a third device joining late gets the current document and is counted', async ({ browser }) => {
    const { a, b, doc } = await cloudPair(browser, ['one']);
    await a.app.type(' two');
    await expectText(b.app, 'one two');
    const third = await browser.newContext();
    await signInAs(third, a.email);
    const page = await third.newPage();
    const c = await openCloud(page, doc.id);
    await expectText(c, 'one two');
    await expect.poll(() => statusLine(a.page)).toContain('3 people here');
    await third.close();
    await b.context.close();
    await a.context.close();
  });

  test('when the other device leaves, the caret goes and the status says you are alone again', async ({ browser }) => {
    const { a, b } = await cloudPair(browser);
    await b.page.close();
    await expect.poll(async () => (await others(a.page)).length).toBe(0);
    await expect.poll(() => statusLine(a.page)).toContain('Editing on your own again');
    // Alone, edits keep saving as usual.
    await a.app.type(' alone');
    await expect(a.page.locator('.wm-sync')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
    await b.context.close();
    await a.context.close();
  });

  test('undo only undoes your own edits', async ({ browser }) => {
    const { a, b } = await cloudPair(browser, ['x']);
    await a.app.type('AAA');
    await expectText(b.app, 'xAAA');
    await b.app.press(`${MOD}+End`);
    await b.app.press('Enter');
    await b.app.type('BBB');
    await expectText(a.app, 'xAAA\nBBB');
    await a.app.focus();
    await a.page.keyboard.press(`${MOD}+z`);
    await expectText(b.app, 'x\nBBB');
    await expectText(a.app, 'x\nBBB');
    await b.context.close();
    await a.context.close();
  });

  test('comments, replies and resolving travel between devices', async ({ browser }) => {
    const { a, b } = await cloudPair(browser, ['alpha beta']);
    await a.app.press('Home');
    await selectForward(a.app, 5);
    await addComment(a.app, 'from device A');
    await expect(commentsTitle(b.page)).toHaveText('Comments (1)');
    expect(await commentTexts(b.page)).toEqual(['from device A']);
    await b.page.locator('.wm-comments .wm-comment').click();
    await b.page.getByPlaceholder('Reply…').fill('answer from B');
    await b.page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(commentsTitle(a.page)).toHaveText('Comments (2)');
    await b.page.getByRole('button', { name: 'Resolve' }).click();
    await a.page.getByLabel('Show resolved').check();
    await expect(a.page.locator('.wm-comments .wm-comment-resolved')).toHaveCount(1);
    await b.context.close();
    await a.context.close();
  });

  test('editing offline, then reconnecting, merges both sides', async ({ browser }) => {
    const { a, b } = await cloudPair(browser, ['base']);
    await b.context.setOffline(true);
    await b.app.focus();
    await b.app.press(`${MOD}+End`);
    await b.app.type(' offline-edit');
    await a.app.type(' online-edit');
    await b.context.setOffline(false);
    await expect
      .poll(async () => {
        const [ta, tb] = [await a.app.text(), await b.app.text()];
        return ta === tb && ta.includes('offline-edit') && ta.includes('online-edit') && ta.startsWith('base');
      }, { timeout: 40_000, message: 'both edits end up on both devices' })
      .toBe(true);
    await b.context.close();
    await a.context.close();
  });

  test('the server keeps what was typed in the room once everyone has left', async ({ browser }) => {
    const { a, b, doc } = await cloudPair(browser, ['kept']);
    await b.app.press(`${MOD}+End`);
    await b.app.type(' and more');
    await expectText(a.app, 'kept and more');
    await b.context.close();
    await a.context.close();
    const later = await newPerson(browser, 'unused');
    await later.context.close();
    const fresh = await browser.newContext();
    await signInAs(fresh, a.email);
    const page = await fresh.newPage();
    // Saving after the room empties takes a moment: the copy converges to the typed text.
    await expect
      .poll(async () => {
        const app = await openCloud(page, doc.id);
        return app.text();
      }, { timeout: 40_000 })
      .toBe('kept and more');
    await fresh.close();
  });

  test('the file cannot be uploaded over while several people are editing (423)', async ({ browser }) => {
    const { a, b, doc } = await cloudPair(browser);
    const response = await a.page.request.put(`/api/documents/${doc.id}`, {
      data: Buffer.from('not a real docx'),
      headers: { origin: 'http://localhost:5273' },
    });
    expect(response.status()).toBe(423);
    await b.context.close();
    await a.context.close();
  });
});

test('a document is not opened in a room when signed out', async ({ browser }) => {
  // Without an account there is no cloud copy and no room: the document is edited on its own.
  const { signedOutContext } = await import('./helpers');
  const context = await signedOutContext(browser);
  const app = new App(await context.newPage());
  await app.blank();
  await app.type('solo');
  expect(await others(app.page)).toEqual([]);
  await context.close();
});
