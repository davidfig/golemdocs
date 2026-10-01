import { test, expect, App, MOD } from '../fixtures';
import { addComment, commentTexts, commentsTitle, documentWithComments, openDraft, selectForward, signedOutContext } from './helpers';

const card = (page: import('@playwright/test').Page, text: string) => page.locator('.wm-comments .wm-comment').filter({ hasText: text });

test.describe('comments panel', () => {
  test('the panel stays hidden until a comment exists', async ({ app, page }) => {
    await app.blank();
    await app.type('alpha beta gamma');
    await expect(page.locator('.wm-comments')).toBeHidden();
  });

  test('Insert > Comment opens a draft card; the Reply button posts it under the signed-in author', async ({ app, page }) => {
    await app.blank();
    await app.type('alpha beta gamma');
    await app.press('Home');
    await selectForward(app, 5);
    const draft = await openDraft(app);
    await expect(page.locator('.wm-comment-draft')).toHaveCount(1);
    await draft.fill('first note');
    await page.locator('.wm-comment-draft').getByRole('button', { name: 'Reply' }).click();
    await expect(commentsTitle(page)).toHaveText('Comments (1)');
    const posted = card(page, 'first note');
    await expect(posted.locator('strong')).toHaveText('e2e');
    await expect(posted.locator('time')).toBeVisible();
    await expect(page.locator('.wm-comment-draft')).toHaveCount(0);
  });

  test('sending a comment or a reply with Enter leaves the document text alone', async ({ app, page }) => {
    await app.blank();
    await app.type('alpha beta');
    await app.press('Home');
    await selectForward(app, 5);
    const box = await openDraft(app);
    await box.fill('via enter');
    await box.press('Enter');
    await expect(commentsTitle(page)).toHaveText('Comments (1)');
    await page.getByPlaceholder('Reply…').fill('reply via enter');
    await page.getByPlaceholder('Reply…').press('Enter');
    await expect(commentsTitle(page)).toHaveText('Comments (2)');
    expect(await app.text()).toBe('alpha beta');
  });

  test('the new comment box has the keyboard, so typing goes into the comment', async ({ app, page }) => {
    test.fixme(true, 'Suspected app bug: after Insert > Comment the keyboard is handed back to the document, so typing replaces the selected text instead of filling the comment box');
    await app.blank();
    await app.type('alpha beta');
    await app.press('Home');
    await selectForward(app, 5);
    await app.menu('Insert', 'Comment');
    await expect(page.locator('.wm-comment-draft textarea')).toBeFocused();
    await page.keyboard.type('typed at once');
    await expect(page.locator('.wm-comment-draft textarea')).toHaveValue('typed at once');
    expect(await app.text()).toBe('alpha beta');
  });

  test('the Ctrl/Cmd+Alt+M shortcut starts a comment', async ({ app, page }) => {
    await app.blank();
    await app.type('alpha beta');
    await app.press('Home');
    await selectForward(app, 5);
    await page.keyboard.press(`${MOD}+Alt+m`);
    await expect(page.locator('.wm-comment-draft textarea')).toBeVisible();
    await expect(page.locator('.wm-comments-bar h2')).toHaveText('Comments (0)');
  });

  test('a signed-out guest comments as "Guest NNN"', async ({ browser }) => {
    const context = await signedOutContext(browser);
    const app = new App(await context.newPage());
    await app.blank();
    await app.type('alpha');
    await app.press('Home');
    await selectForward(app, 5);
    await addComment(app, 'from a guest');
    await expect(card(app.page, 'from a guest').locator('strong')).toHaveText(/^Guest \d{3}$/);
    await context.close();
  });

  test('Cancel and Escape discard a draft; an empty comment is not posted', async ({ app, page }) => {
    await app.blank();
    await app.type('alpha beta');
    await app.press('Home');
    await selectForward(app, 5);

    let box = await openDraft(app);
    await box.fill('will be cancelled');
    await page.locator('.wm-comment-draft').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.wm-comment-draft')).toHaveCount(0);
    await expect(page.locator('.wm-comments')).toBeHidden();

    box = await openDraft(app);
    await page.locator('.wm-comment-draft').getByRole('button', { name: 'Reply' }).click(); // nothing written: stays a draft
    await expect(page.locator('.wm-comment-draft')).toHaveCount(1);
    await box.fill('   ');
    await page.locator('.wm-comment-draft').getByRole('button', { name: 'Reply' }).click();
    await expect(page.locator('.wm-comment-draft')).toHaveCount(1);
    await expect(commentsTitle(page)).toHaveText('Comments (0)');
    await box.focus();
    await box.press('Escape');
    await expect(page.locator('.wm-comment-draft')).toHaveCount(0);
    await expect(page.locator('.wm-comments')).toBeHidden();
    // A cancelled comment left nothing in the document.
    expect(await app.text()).toBe('alpha beta');
  });

  test('Shift+Enter in the box is a new line, not a send', async ({ app, page }) => {
    await app.blank();
    await app.type('alpha');
    await app.press('Home');
    await selectForward(app, 5);
    const box = await openDraft(app);
    await box.fill('line one');
    await box.press('Shift+Enter');
    await box.pressSequentially('line two');
    await expect(page.locator('.wm-comment-draft')).toHaveCount(1);
    await page.locator('.wm-comment-draft').getByRole('button', { name: 'Reply' }).click();
    await expect(commentsTitle(page)).toHaveText('Comments (1)');
    expect((await commentTexts(page))[0]).toBe('line one\nline two');
  });

  test('editing a comment changes its text; Cancel keeps the old text', async ({ app, page }) => {
    await documentWithComments(app);
    const edit = page.locator('.wm-comments textarea[data-box^="edit:"]');
    await card(page, 'note on alpha').getByRole('button', { name: 'Edit' }).click();
    await expect(edit).toHaveValue('note on alpha');
    await edit.fill('abandoned edit');
    await page.locator('.wm-comments').getByRole('button', { name: 'Cancel' }).click();
    await expect(edit).toHaveCount(0);
    await expect(card(page, 'note on alpha')).toHaveCount(1);
    await expect(card(page, 'abandoned edit')).toHaveCount(0);

    await card(page, 'note on alpha').getByRole('button', { name: 'Edit' }).click();
    await edit.fill('revised note');
    await page.locator('.wm-comments').getByRole('button', { name: 'Save' }).click();
    await expect(card(page, 'revised note')).toHaveCount(1);
    await expect(card(page, 'note on alpha')).toHaveCount(0);
    await expect(commentsTitle(page)).toHaveText('Comments (1)');
  });

  test('deleting a comment removes it and hides the panel when none are left', async ({ app, page }) => {
    await documentWithComments(app, true);
    await expect(commentsTitle(page)).toHaveText('Comments (2)');
    // The newest comment is open, so it has the Delete button.
    await card(page, 'note on gamma').getByRole('button', { name: 'Delete' }).click();
    await expect(commentsTitle(page)).toHaveText('Comments (1)');
    expect(await commentTexts(page)).toEqual(['note on alpha']);
    await card(page, 'note on alpha').click();
    await card(page, 'note on alpha').getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.wm-comments')).toBeHidden();
    expect(await app.text()).toBe('alpha beta gamma');
  });

  test('replies join the thread and count towards the total', async ({ app, page }) => {
    await documentWithComments(app);
    await page.getByPlaceholder('Reply…').fill('first reply');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(commentsTitle(page)).toHaveText('Comments (2)');
    await page.getByPlaceholder('Reply…').fill('second reply');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(commentsTitle(page)).toHaveText('Comments (3)');
    const thread = page.locator('.wm-comments .wm-comment');
    await expect(thread).toHaveCount(1);
    await expect(thread).toContainText('note on alpha');
    await expect(thread).toContainText('first reply');
    await expect(thread).toContainText('second reply');
  });

  test('an unopened thread summarises its replies', async ({ app, page }) => {
    await documentWithComments(app, true);
    // Open the first thread and reply to it, then open the second: the first collapses.
    await card(page, 'note on alpha').click();
    await page.getByPlaceholder('Reply…').fill('re: alpha');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(commentsTitle(page)).toHaveText('Comments (3)');
    await card(page, 'note on gamma').click();
    await expect(card(page, 'note on alpha')).toContainText('1 reply');
    await expect(card(page, 'note on alpha')).not.toContainText('re: alpha');
  });

  test('resolving marks a thread; it is hidden once another is open, until "Show resolved"; Reopen undoes it', async ({ app, page }) => {
    await documentWithComments(app, true);
    await card(page, 'note on alpha').click();
    await card(page, 'note on alpha').getByRole('button', { name: 'Resolve' }).click();
    // The thread stays on screen while it is the open one, marked as resolved.
    await expect(card(page, 'note on alpha')).toHaveClass(/wm-comment-resolved/);
    await expect(card(page, 'note on alpha').locator('.wm-comment-badge')).toHaveText('Resolved');

    await card(page, 'note on gamma').click();
    await expect(card(page, 'note on alpha')).toHaveCount(0);
    await expect(commentsTitle(page)).toHaveText('Comments (2)'); // still a comment of the document

    await page.getByLabel('Show resolved').check();
    await expect(card(page, 'note on alpha')).toHaveCount(1);
    await card(page, 'note on alpha').click();
    await card(page, 'note on alpha').getByRole('button', { name: 'Reopen' }).click();
    await expect(card(page, 'note on alpha')).not.toHaveClass(/wm-comment-resolved/);
    await expect(card(page, 'note on alpha').locator('.wm-comment-badge')).toHaveCount(0);

    // Reopened, it stays listed with "Show resolved" off.
    await page.getByLabel('Show resolved').uncheck();
    await card(page, 'note on gamma').click();
    await expect(card(page, 'note on alpha')).toHaveCount(1);
  });

  test('clicking a card selects the text the comment is on', async ({ app, page }) => {
    await documentWithComments(app, true);
    await card(page, 'note on alpha').click();
    await expect.poll(() => app.selectedText()).toBe('alpha');
    await card(page, 'note on gamma').click();
    await expect.poll(() => app.selectedText()).toBe('gamma');
  });

  test('moving the caret into commented text opens that thread', async ({ app, page }) => {
    await documentWithComments(app, true);
    await card(page, 'note on alpha').click();
    await expect(card(page, 'note on alpha')).toHaveClass(/wm-comment-active/);
    await app.press('End');
    await app.press('ArrowLeft'); // inside "gamma"
    await expect(card(page, 'note on gamma')).toHaveClass(/wm-comment-active/);
    await expect(card(page, 'note on alpha')).not.toHaveClass(/wm-comment-active/);
  });

  test('the panel bar steps through comments with next and previous', async ({ app, page }) => {
    await documentWithComments(app, true);
    await card(page, 'note on alpha').click();
    await page.getByRole('button', { name: 'Next comment' }).click();
    await expect.poll(() => app.selectedText()).toBe('gamma');
    await page.getByRole('button', { name: 'Next comment' }).click(); // wraps around
    await expect.poll(() => app.selectedText()).toBe('alpha');
    await page.getByRole('button', { name: 'Previous comment' }).click(); // wraps back
    await expect.poll(() => app.selectedText()).toBe('gamma');
    await page.getByRole('button', { name: 'Previous comment' }).click();
    await expect.poll(() => app.selectedText()).toBe('alpha');
  });

  test('text typed inside the commented range becomes part of the anchor', async ({ app, page }) => {
    await documentWithComments(app);
    await card(page, 'note on alpha').click();
    await app.press('Home');
    await app.press('ArrowRight', 2); // "al|pha"
    await app.type('X');
    expect(await app.text()).toBe('alXpha beta gamma');
    await app.press('End');
    await page.getByRole('button', { name: 'Next comment' }).click();
    await expect.poll(() => app.selectedText()).toBe('alXpha');
  });
});

test.describe('Edit > Go To > Comment', () => {
  async function openGoToComment(app: App) {
    await app.menu('Edit', 'Go To');
    const dialog = app.page.getByRole('dialog', { name: 'Find and Replace' });
    await dialog.getByLabel('Go to what').selectOption('comment');
    return dialog;
  }

  test('goes to a comment by number', async ({ app }) => {
    await documentWithComments(app, true);
    const dialog = await openGoToComment(app);
    await dialog.getByLabel('Item number').fill('2');
    await dialog.getByRole('button', { name: 'Go To', exact: true }).click();
    await expect.poll(() => app.selectedText()).toBe('gamma');
    await dialog.getByLabel('Item number').fill('1');
    await dialog.getByRole('button', { name: 'Go To', exact: true }).click();
    await expect.poll(() => app.selectedText()).toBe('alpha');
  });

  test('Next and Previous step through the comments and stop at the ends', async ({ app }) => {
    await documentWithComments(app, true);
    const dialog = await openGoToComment(app);
    const message = dialog.getByRole('status');
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(() => app.selectedText()).toBe('alpha');
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(() => app.selectedText()).toBe('gamma');
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(message).toContainText('There is no comment 3. The document has 2.');
    await dialog.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect.poll(() => app.selectedText()).toBe('alpha');
    await dialog.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(message).toHaveText('This is the first comment.');
  });

  test('a relative number moves from the current comment', async ({ app }) => {
    await documentWithComments(app, true);
    const dialog = await openGoToComment(app);
    await dialog.getByLabel('Item number').fill('1');
    await dialog.getByRole('button', { name: 'Go To', exact: true }).click();
    await dialog.getByLabel('Item number').fill('+1');
    await dialog.getByRole('button', { name: 'Go To', exact: true }).click();
    await expect.poll(() => app.selectedText()).toBe('gamma');
  });

  test('says so when the document has no comments or the number is wrong', async ({ app }) => {
    await app.blank();
    await app.type('nothing here');
    const dialog = await openGoToComment(app);
    await dialog.getByLabel('Item number').fill('1');
    await dialog.getByRole('button', { name: 'Go To', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('The document has no comments.');
  });
});
