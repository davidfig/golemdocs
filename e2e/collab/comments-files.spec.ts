import { test, expect, App } from '../fixtures';
import { addComment, commentTexts, commentsTitle, documentWithComments, newPerson, openFile, selectForward, unzip, waitForCloudDoc, waitSaved } from './helpers';
import { signInAs } from './helpers';

const card = (page: import('@playwright/test').Page, text: string) => page.locator('.wm-comments .wm-comment').filter({ hasText: text });

/** A document with a resolved thread "note on alpha" (plus a reply) and an open comment "note on gamma". */
async function richDocument(app: App): Promise<void> {
  await documentWithComments(app, true);
  await card(app.page, 'note on alpha').click();
  await app.page.getByPlaceholder('Reply…').fill('a reply');
  await app.page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(commentsTitle(app.page)).toHaveText('Comments (3)');
  await card(app.page, 'note on alpha').getByRole('button', { name: 'Resolve' }).click();
  await expect(card(app.page, 'note on alpha').locator('.wm-comment-badge')).toBeVisible();
}

test.describe('comments persist', () => {
  test('comments are still there after reloading the page', async ({ browser }) => {
    const person = await newPerson(browser, 'persist');
    await documentWithComments(person.app, true);
    await waitSaved(person.page);
    await person.page.reload();
    await person.app.ready();
    await expect(commentsTitle(person.page)).toHaveText('Comments (2)');
    expect(await commentTexts(person.page)).toEqual(['note on alpha', 'note on gamma']);
    await card(person.page, 'note on gamma').click();
    await expect.poll(() => person.app.selectedText()).toBe('gamma');
    await person.context.close();
  });

  test('a reply and a resolved state survive a reload', async ({ browser }) => {
    const person = await newPerson(browser, 'persist');
    await richDocument(person.app);
    await waitSaved(person.page);
    await person.page.reload();
    await person.app.ready();
    await expect(commentsTitle(person.page)).toHaveText('Comments (3)');
    await expect(card(person.page, 'note on alpha')).toHaveCount(0); // resolved: hidden
    await person.page.getByLabel('Show resolved').check();
    await card(person.page, 'note on alpha').click();
    await expect(card(person.page, 'note on alpha')).toContainText('a reply');
    await expect(card(person.page, 'note on alpha').locator('.wm-comment-badge')).toHaveText('Resolved');
    await person.context.close();
  });

  test('the account keeps the comments: a second device opening the cloud copy sees them', async ({ browser }) => {
    const person = await newPerson(browser, 'persist');
    await documentWithComments(person.app, true);
    await waitSaved(person.page);
    const doc = await waitForCloudDoc(person.page);
    const other = await browser.newContext();
    await signInAs(other, person.email);
    const page = await other.newPage();
    await page.goto(`/?doc=cloud:${doc.id}`);
    await new App(page).ready();
    await expect(commentsTitle(page)).toHaveText('Comments (2)');
    expect(await commentTexts(page)).toEqual(['note on alpha', 'note on gamma']);
    await other.close();
    await person.context.close();
  });
});

test.describe('comments in downloaded files', () => {
  test('DOCX has comments.xml, anchors and commentsExtended (replies, resolved)', async ({ app }) => {
    await richDocument(app);
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.name).toMatch(/\.docx$/);
    const parts = unzip(file.bytes);
    const comments = parts['word/comments.xml']!.toString();
    expect(comments).toContain('note on alpha');
    expect(comments).toContain('note on gamma');
    expect(comments).toContain('a reply');
    expect(comments).toContain('w:author="e2e"');
    expect((comments.match(/<w:comment /g) ?? []).length).toBe(3);

    const document = parts['word/document.xml']!.toString();
    expect((document.match(/<w:commentRangeStart /g) ?? []).length).toBe(3);
    expect((document.match(/<w:commentReference /g) ?? []).length).toBe(3);

    const extended = parts['word/commentsExtended.xml']!.toString();
    const entries = extended.match(/<w15:commentEx [^>]*\/>/g) ?? [];
    expect(entries).toHaveLength(3);
    expect(entries.filter((e) => e.includes('w15:paraIdParent'))).toHaveLength(1); // the reply
    expect(entries.filter((e) => e.includes('w15:done="1"'))).toHaveLength(1); // the resolved thread's root
    expect(entries.filter((e) => e.includes('w15:done="0"'))).toHaveLength(2);
    expect(parts['[Content_Types].xml']!.toString()).toContain('commentsExtended');
  });

  test('DOCX round trip: reopening the downloaded file restores comments, replies and resolved state', async ({ app }) => {
    await richDocument(app);
    const file = await app.download(() => app.menu('File', 'Download'));
    await app.goto('?doc=welcome');
    await openFile(app, 'with-comments.docx', file.bytes);
    await expect(commentsTitle(app.page)).toHaveText('Comments (3)');
    await app.page.getByLabel('Show resolved').check();
    await card(app.page, 'note on alpha').click();
    await expect(card(app.page, 'note on alpha')).toContainText('a reply');
    await expect(card(app.page, 'note on alpha').locator('.wm-comment-badge')).toHaveText('Resolved');
    await card(app.page, 'note on gamma').click();
    await expect.poll(() => app.selectedText()).toBe('gamma');
  });

  test('Markdown writes comments as CriticMarkup', async ({ app, page }) => {
    await richDocument(app);
    await app.menu('File', 'Convert To', 'Markdown');
    await expect(app.page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/Markdown/);
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.name).toMatch(/\.md$/);
    expect(file.text).toMatch(/\{==alpha==\}\{>>✓ @e2e \([0-9T:\-Z]+\): note on alpha<<\}/);
    expect(file.text).toMatch(/\{>>↳ @e2e \([0-9T:\-Z]+\): a reply<<\}/);
    expect(file.text).toMatch(/\{==gamma==\}\{>>@e2e \([0-9T:\-Z]+\): note on gamma<<\}/);
    void page;
  });

  test('Markdown with CriticMarkup opens with its comments', async ({ app }) => {
    await app.goto('?doc=welcome');
    await openFile(app, 'review.md', 'Some {==marked text==}{>>@Ann (2024-05-01T10:00:00Z): please check this<<} in a file.\n', 'text/markdown');
    await expect(commentsTitle(app.page)).toHaveText('Comments (1)');
    const c = card(app.page, 'please check this');
    await expect(c.locator('strong')).toHaveText('Ann');
    await c.click();
    await expect.poll(() => app.selectedText()).toBe('marked text');
  });

  test('HTML writes comments as <mark class="comment"> elements with author, text and thread', async ({ app }) => {
    await richDocument(app);
    await app.menu('File', 'Convert To', 'Web Page');
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.name).toMatch(/\.html$/);
    expect(file.text).toContain('data-comment="note on alpha"');
    expect(file.text).toContain('data-comment="a reply"');
    expect(file.text).toContain('data-comment="note on gamma"');
    expect(file.text).toContain('data-author="e2e"');
    const marks = file.text.match(/<mark class="comment"[^>]*>/g) ?? [];
    expect(marks).toHaveLength(3);
    expect(marks.filter((m) => m.includes('data-parent='))).toHaveLength(1);
  });
});

test('a document without comments writes no comment parts', async ({ app }) => {
  await app.blank();
  await app.type('plain');
  const parts = unzip((await app.download(() => app.menu('File', 'Download'))).bytes);
  expect(parts['word/comments.xml']).toBeUndefined();
  expect(parts['word/commentsExtended.xml']).toBeUndefined();
});
