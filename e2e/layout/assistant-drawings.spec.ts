// The assistant's tools for drawings in the text, a picture's layers and who is editing, run through the page (the model is not involved:
// each tool is called as the model's call would be), against the real app.

import { expect, test } from '../fixtures';
import type { App } from '../fixtures';
import { currentPicture, expectPicture, isReddish, makePng, openPicture } from './helpers';
import { newPerson, secondDevice } from '../collab/helpers';
import { importFile } from '../files/helpers';

/** Runs one tool, as the assistant's call of it would, and gives its answer. */
async function tool(app: App, name: string, args: object = {}): Promise<string> {
  return app.page.evaluate(
    async ([n, a]) => {
      const t = (window as unknown as { assistantTools: { begin(s: AbortSignal): void; run(n: string, a: string, s: AbortSignal): Promise<string | { text: string }> } }).assistantTools;
      const signal = new AbortController().signal;
      t.begin(signal);
      const result = await t.run(n as string, a as string, signal);
      return typeof result === 'string' ? result : result.text;
    },
    [name, JSON.stringify(args)] as [string, string],
  );
}

test.describe('drawings in the text', () => {
  test('inserted, drawn in, put back, listed and opened again', async ({ app }) => {
    await app.blank();
    await app.type('Before');
    expect(await tool(app, 'list_text_drawings')).toContain('no drawings in the text');
    expect(await tool(app, 'insert_text_drawing', { width: 300, height: 200 })).toContain('Inserted a blank drawing');
    // It is open for drawing: the drawing tools work on it.
    expect(await tool(app, 'read_drawing')).toContain('300');
    expect(await tool(app, 'edit_drawing', { op: 'add_rect', x: 20, y: 20, width: 100, height: 60, fill: '#e53935' })).toContain('rect');
    expect(await tool(app, 'close_text_drawing')).toBe('The drawing is back in the text.');
    const listed = await tool(app, 'list_text_drawings');
    expect(listed).toMatch(/^0: page 1, 300 x 200 px$/);
    expect(await tool(app, 'close_text_drawing')).toContain('no drawing in the text is open');
    // Opened again, the rectangle is in it.
    expect(await tool(app, 'open_text_drawing', { number: 0 })).toContain('Opened drawing 0');
    expect(await tool(app, 'read_drawing')).toMatch(/rect/i);
    expect(await tool(app, 'open_text_drawing', { number: 0 })).toContain('is being edited');
    await tool(app, 'close_text_drawing');
    expect(await tool(app, 'open_text_drawing', { number: 4 })).toContain('there is no drawing 4');
  });

  test('a drawing document is not a drawing in the text', async ({ app }) => {
    await app.blank();
    await app.menu('File', 'Convert To', 'PNG Image');
    expect(await tool(app, 'insert_text_drawing')).toContain('not text');
  });
});

test.describe('a picture’s layers', () => {
  const CANVAS = makePng(400, 300, () => [255, 255, 255, 255]);

  test('draw adds a layer, layers lists it, erase and flatten work, and the saved picture has the shapes', async ({ app }) => {
    await openPicture(app, CANVAS);
    expect(await tool(app, 'edit_picture', { op: 'layers' })).toBe('No shapes are drawn over the picture.');
    expect(await tool(app, 'edit_picture', { op: 'draw', tool: 'line', x: 20, y: 100, to_x: 300, to_y: 100, color: '#ff0000', width: 6 })).toContain('as shape 0');
    expect(await tool(app, 'edit_picture', { op: 'draw', tool: 'rectangle', x: 40, y: 150, to_x: 200, to_y: 250, color: '#ff0000' })).toContain('as shape 1');
    expect(await tool(app, 'edit_picture', { op: 'layers' })).toMatch(/^0: line from \(20, 100\) to \(300, 100\); #ff0000; width 6\n1: rectangle/);
    expect(await app.page.evaluate(() => (window as unknown as { pictureShapes: unknown[] }).pictureShapes.length)).toBe(2);
    await expectPicture(app, (i) => isReddish([...i.data.slice((100 * i.width + 150) * 4, (100 * i.width + 150) * 4 + 4)] as never));
    expect(await tool(app, 'edit_picture', { op: 'move_shape', number: 0, dx: 0, dy: 20 })).toContain('move shape 0');
    expect(await tool(app, 'edit_picture', { op: 'erase_shape', number: 1 })).toContain('erase shape 1');
    expect(await tool(app, 'edit_picture', { op: 'layers' })).toMatch(/^0: line from \(20, 120\)/);
    // Flatten puts the line into the pixels: no layers are left, and the picture still shows it.
    expect(await tool(app, 'edit_picture', { op: 'flatten' })).toContain('in the picture now');
    await expect.poll(async () => tool(app, 'edit_picture', { op: 'layers' })).toBe('No shapes are drawn over the picture.');
    const img = await currentPicture(app);
    expect(isReddish([...img.data.slice((120 * img.width + 150) * 4, (120 * img.width + 150) * 4 + 4)] as never)).toBe(true);
  });

  test('with another device in the picture, the one holding it changes it, and the other’s assistant is told to take it over first', async ({ browser }) => {
    const person = await newPerson(browser, 'picture');
    await person.page.goto('/?doc=welcome');
    await openPicture(person.app, CANVAS);
    const { context, a, b } = await secondDevice(browser, person);
    expect(await tool(b, 'edit_picture', { op: 'rotate_left' })).toMatch(/^Error: the person is editing this document on another of their devices.*take it over/);
    expect(await tool(b, 'edit_picture', { op: 'draw', tool: 'line', x: 10, y: 10, to_x: 200, to_y: 10 })).toMatch(/^Error: /);
    expect(await tool(b, 'collaboration_status')).toMatch(/one person at a time, and the person, on another of their devices holds it/);
    expect(await tool(a, 'edit_picture', { op: 'draw', tool: 'line', x: 10, y: 10, to_x: 200, to_y: 10 })).toContain('Done: draw line');
    expect(await tool(a, 'edit_picture', { op: 'rotate_left' })).toContain('Done: rotate left');
    // The other device sees it turned once it is saved.
    await expect.poll(async () => (await currentPicture(b)).width, { timeout: 30_000 }).toBe((await currentPicture(a)).width);
    // Taking over: the other device's assistant can change it then.
    expect(await tool(b, 'take_over_editing')).toMatch(/^Asked to take it over/);
    await expect.poll(() => tool(b, 'collaboration_status'), { timeout: 30_000 }).toMatch(/the person holds it/);
    expect(await tool(b, 'edit_picture', { op: 'rotate_right' })).toContain('Done: rotate right');
    await context.close();
  });

});

test.describe('who is editing', () => {
  test('alone, nobody else is; with another person here, the tools say so', async ({ browser }) => {
    const person = await newPerson(browser, 'status');
    await person.page.goto('/?doc=welcome');
    const a = person.app;
    await a.blank();
    await a.type('shared text');
    expect(await tool(a, 'collaboration_status')).toBe('Nobody else is editing this document now.');
    const { context } = await secondDevice(browser, person);
    await expect.poll(() => tool(a, 'collaboration_status'), { timeout: 30_000 }).toMatch(/^Here now: .+ \(you\), .+\. Everyone can edit at once\./);
    await context.close();
  });
});

test.describe('a drawing in a room', () => {
  const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect id="red" x="20" y="20" width="120" height="80" fill="#e53935"/></svg>';

  test('both may edit at once, and the status says so', async ({ browser }) => {
    const person = await newPerson(browser, 'drawing');
    await person.page.goto('/?doc=welcome');
    await importFile(person.app, { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(DRAWING) });
    await person.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().waitFor({ timeout: 30_000 });
    const { context, a, b } = await secondDevice(browser, person);
    await b.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().waitFor({ timeout: 30_000 });
    expect(await tool(a, 'edit_drawing', { op: 'add_rect', x: 200, y: 20, width: 50, height: 50 })).not.toContain('Error');
    expect(await tool(b, 'edit_drawing', { op: 'add_rect', x: 0, y: 0, width: 5, height: 5 })).not.toContain('Error');
    const rows = (app: App) => app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    await expect(rows(a)).toHaveCount(3, { timeout: 30_000 });
    await expect(rows(b)).toHaveCount(3, { timeout: 30_000 });
    await context.close();
  });
});

test.describe('a drawing in a Markdown note', () => {
  test('insert_text_drawing stores it, embeds it and opens it; close puts it back', async ({ app }) => {
    await app.goto('?doc=welcome');
    await importFile(app, { name: 'Notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Intro line.\n\n') });
    await app.page.waitForFunction(() => (window as unknown as { loaded: boolean }).loaded === true);
    expect(await tool(app, 'insert_text_drawing', { width: 320, height: 200 })).toContain('Inserted a blank drawing');
    expect(await tool(app, 'edit_drawing', { op: 'add_ellipse', x: 20, y: 20, width: 100, height: 60 })).not.toContain('Error');
    expect(await tool(app, 'close_text_drawing')).toBe('The drawing is back in the text.');
    // The note is opened again showing the embed once the drawing is stored; then the note holds the embed, not the drawing.
    await expect.poll(() => tool(app, 'list_text_drawings'), { timeout: 30_000 }).toMatch(/embedded from "Drawing( 2)?\.svg"/);
    expect((await app.download(() => app.menu('File', 'Download'))).text).toMatch(/!\[\[Drawing( 2)?\.svg\]\]/);
  });
});
