// Live editing through the server's rooms (a Durable Object per cloud document). Two browser
// contexts signed in as the SAME account are two devices; both open the cloud copy and end up in
// the document's room. (A second, different account can't open a document shared with it yet:
// see share-people.spec.ts.)

import { test, expect, App, MOD } from '../fixtures';
import { CLIENT_ORIGIN } from '../ports.ts';
import { docx, makePng } from '../layout/helpers';
import { importFile } from '../files/helpers';
import { annotations, makePdf, openPdf, selectBetween, showPage } from '../pdf/helpers';
import { openPicture, pictureToScreen } from '../layout/helpers';
import { addComment, cloudPair, cloudParts, unzip, commentTexts, markdownWdoc, commentsTitle, expectText, newPerson, openCloud, others, selectForward, signInAs, statusLine, makeDocx, uploadDoc, waitForCloudDoc } from './helpers';

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

  test('avatars beside the document name show who is here, and go when the other device leaves', async ({ browser }) => {
    const { a, b } = await cloudPair(browser);
    const presence = a.page.locator('.wm-doctitle .wm-presence');
    await expect(presence).toBeVisible();
    await expect(presence.locator('.wm-avatar')).toHaveCount(1);
    await expect(presence).toHaveAttribute('title', a.name);
    await b.page.close();
    await expect(presence).toBeHidden();
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

  test('editing offline, then reconnecting, merges both sides', { tag: '@heavy' }, async ({ browser }) => {
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
      headers: { origin: CLIENT_ORIGIN },
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

test.describe('a cloud Markdown document in a room', () => {
  test('both devices edit it as Markdown, and the cloud copy is still a Markdown document with its front matter after the edits', async ({ browser }) => {
    const { a, b, doc } = await cloudPair(browser, ['Hello'], { name: 'Notes.md', wrap: (docx) => markdownWdoc(docx, 'title: Notes') });
    await expect(a.page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/Markdown/);
    await expect(b.page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/Markdown/);
    await expectText(b.app, 'Hello');
    await b.app.type(' from B');
    await expectText(a.app, 'Hello from B');
    // The room's own copy goes to the account as the same kind of file it was: Markdown, with its front matter.
    await expect
      .poll(async () => {
        const parts = await cloudParts(a.page, doc.id);
        const manifest = parts['manifest.json'] ? JSON.parse(parts['manifest.json'].toString()) : null;
        const text = parts['document.docx'] ? (unzip(parts['document.docx'])['word/document.xml']?.toString() ?? '') : '';
        return manifest?.lens === 'md' && parts['extensions/md.json']?.toString().includes('title: Notes') && text.includes('from B');
      }, { timeout: 30_000 })
      .toBe(true);
    await b.context.close();
    await a.context.close();
  });
});

test.describe('pictures and drawings in a cloud document', () => {
  const imagesOn = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (window as unknown as { pages: { images: unknown[] }[] }).pages.reduce((n, pg) => n + pg.images.length, 0));

  test('they go in alone, travel with the document to a device that joins, and a picture added by either device reaches the other with its bytes', async ({ browser }) => {
    const person = await newPerson(browser, 'pictures');
    const doc = await uploadDoc(person.page, 'Mine.docx', await makeDocx(browser, ['hello']));
    const app = await openCloud(person.page, doc.id);
    await app.focus();
    const insert = async (on: App, picture: Buffer): Promise<void> => {
      const [chooser] = await Promise.all([on.page.waitForEvent('filechooser'), on.menu('Insert', 'Picture…')]);
      await chooser.setFiles({ name: 'a.png', mimeType: 'image/png', buffer: picture });
    };
    await insert(app, makePng(40, 40));
    await expect.poll(() => imagesOn(person.page)).toBe(1);
    await app.menu('Insert', 'Drawing');
    await expect.poll(() => imagesOn(person.page)).toBe(2);

    // Another device joins: the pictures go to it with the document.
    const other = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await signInAs(other, person.email);
    const page = await other.newPage();
    const second = await openCloud(page, doc.id);
    await expect.poll(async () => (await others(person.page)).length, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => imagesOn(page), { timeout: 30_000 }).toBe(2);

    // It adds one: the first device gets it, and has the bytes, not just a place for them.
    await second.focus();
    const added = makePng(30, 20);
    await insert(second, added);
    await expect.poll(() => imagesOn(person.page), { timeout: 30_000 }).toBe(3);
    await expect.poll(() => imagesOn(page)).toBe(3);
    const { files } = await docx(app);
    const media = [...files.keys()].filter((k) => /^word\/media\/h-[0-9a-f]{64}\.png$/.test(k));
    expect(media).toHaveLength(1);
    expect(files.get(media[0]!)!.equals(added)).toBe(true);
    // And the account's copy, written by the room, has it too.
    await expect
      .poll(async () => Object.keys(await cloudParts(person.page, doc.id).then((parts) => (parts['document.docx'] ? unzip(parts['document.docx']) : parts))).some((k) => /^word\/media\/h-[0-9a-f]{64}\.png$/.test(k)), { timeout: 30_000 })
      .toBe(true);
    await other.close();
    await person.context.close();
  });
});

test.describe('a cloud drawing in a room', () => {
  test('both devices edit at once; what one draws appears on the other and in the account’s copy', async ({ browser }) => {
    const a = await newPerson(browser, 'drawing');
    await a.page.goto('/?doc=welcome');
    await importFile(a.app, { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect id="red" x="20" y="20" width="120" height="80" fill="#e53935"/></svg>') });
    const layers = (page: import('@playwright/test').Page) => page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    await expect(layers(a.page)).toHaveCount(1, { timeout: 30_000 });
    const doc = await waitForCloudDoc(a.page);

    const other = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await signInAs(other, a.email);
    const page = await other.newPage();
    await openCloud(page, doc.id);
    await expect(layers(page)).toHaveCount(1, { timeout: 30_000 });

    // Nobody waits for their turn: a shape drawn by one reaches the other.
    await a.app.toolbarButton('Rectangle').click();
    const box = await a.page.locator('.wm-vector-canvas').boundingBox();
    await a.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await a.page.mouse.down();
    await a.page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 30);
    await a.page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2 + 60);
    await a.page.mouse.up();
    await expect(layers(a.page)).toHaveCount(2);
    await expect(layers(page)).toHaveCount(2, { timeout: 30_000 });
    // The room writes the drawing into the account’s copy.
    await expect
      .poll(async () => {
        const parts = await cloudParts(a.page, doc.id);
        const vec = parts['extensions/vec.json']?.toString() ?? '';
        return (vec.match(/"kind":\s*"rect"/g) ?? []).length;
      }, { timeout: 30_000 })
      .toBe(2);
    await other.close();
    await a.context.close();
  });
});

test.describe('a cloud PDF in a room', () => {
  test('markup from either device reaches the other, and the account’s copy keeps the PDF with the markup written into its lists', async ({ browser }) => {
    const a = await newPerson(browser, 'pdf');
    await a.page.goto('/?doc=welcome');
    await openPdf(a.app, makePdf({ pages: [[{ text: 'Hello PDF world', x: 40, y: 240, size: 18 }, { text: 'Second line of text', x: 40, y: 200, size: 18 }]] }));
    const doc = await waitForCloudDoc(a.page);

    const other = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await signInAs(other, a.email);
    const page = await other.newPage();
    const second = await openCloud(page, doc.id);
    await expect.poll(() => statusLine(a.page), { timeout: 30_000 }).toContain('2 people here');
    await showPage(a.page, 0);
    await showPage(page, 0);

    const save = async (app: App) => (await app.download(() => app.menu('File', 'Download'))).bytes;
    const button = (on: import('@playwright/test').Page, name: string) => on.getByRole('button', { name, exact: true });
    await selectBetween(a.page, 0, [41, 54], [120, 54]);
    await button(a.page, 'Highlight').click();
    await expect.poll(async () => annotations(await save(second), 'Highlight').length, { timeout: 30_000 }).toBe(1);
    await selectBetween(page, 0, [41, 94], [120, 94]);
    await button(page, 'Underline').click();
    await expect.poll(async () => annotations(await save(a.app), 'Underline').length, { timeout: 30_000 }).toBe(1);

    // The room wrote both into the account's copy: still a PDF document, the file untouched, the lists holding what was drawn.
    await expect
      .poll(async () => {
        const parts = await cloudParts(a.page, doc.id);
        const manifest = parts['manifest.json'] ? JSON.parse(parts['manifest.json'].toString()) : null;
        const extension = parts['extensions/pdf.json'] ? JSON.parse(parts['extensions/pdf.json'].toString()) : null;
        const kinds = ((extension?.annotations ?? []) as { kind: string }[]).map((x) => x.kind).sort();
        return manifest?.lens === 'pdf' && !!parts['originals/source.pdf'] && kinds.includes('highlight') && kinds.includes('underline');
      }, { timeout: 30_000 })
      .toBe(true);
    await other.close();
    await a.context.close();
  });
});

test.describe('a cloud picture in a room', () => {
  test('shapes drawn on either device appear on the other, and the account’s copy keeps the picture with the shapes as its layers', async ({ browser }) => {
    const a = await newPerson(browser, 'picture');
    await a.page.goto('/?doc=welcome');
    await openPicture(a.app, makePng(400, 300, () => [255, 255, 255, 255]));
    const doc = await waitForCloudDoc(a.page);

    const other = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await signInAs(other, a.email);
    const page = await other.newPage();
    const second = await openCloud(page, doc.id);
    await expect.poll(() => statusLine(a.page), { timeout: 30_000 }).toContain('2 people here');

    const shapes = (on: import('@playwright/test').Page) => on.evaluate(() => (window as unknown as { pictureShapes: { tool: string }[] }).pictureShapes.filter((s) => s.tool !== 'group').map((s) => s.tool).sort());
    const drag = async (app: App, from: [number, number], to: [number, number]) => {
      const p = await pictureToScreen(app.page, 400, ...from);
      const q = await pictureToScreen(app.page, 400, ...to);
      await app.page.mouse.move(p.x, p.y);
      await app.page.mouse.down();
      await app.page.mouse.move(q.x, q.y, { steps: 6 });
      await app.page.mouse.up();
    };
    await a.app.toolbarButton(/^Line$/).click();
    await drag(a.app, [40, 40], [240, 40]);
    await expect.poll(() => shapes(page), { timeout: 30_000 }).toEqual(['line']);
    await second.toolbarButton(/^Rectangle$/).click();
    await drag(second, [40, 150], [240, 250]);
    await expect.poll(() => shapes(a.page), { timeout: 30_000 }).toEqual(['line', 'rectangle']);

    // The room wrote both into the account's copy: still a picture document, the picture untouched, the shapes in its extension.
    await expect
      .poll(async () => {
        const parts = await cloudParts(a.page, doc.id);
        const manifest = parts['manifest.json'] ? JSON.parse(parts['manifest.json'].toString()) : null;
        const extension = parts['extensions/img.json'] ? JSON.parse(parts['extensions/img.json'].toString()) : null;
        const tools = ((extension?.shapes ?? []) as { tool: string }[]).filter((s) => s.tool !== 'group').map((s) => s.tool).sort();
        return manifest?.lens === 'png' && !!parts['document.docx'] && tools.join() === 'line,rectangle';
      }, { timeout: 30_000 })
      .toBe(true);
    await other.close();
    await a.context.close();
  });
});
