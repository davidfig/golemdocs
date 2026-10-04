// The assistant's tools for what was added with editing together: drawings in the text, who is editing, a picture's layers, and what
// they refuse while others are in the document (src/assistant/appTools.ts), against a stand-in for the page.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appTools, type AppToolsHost, type Collaboration } from '../src/assistant/appTools.ts';
import type { Shape } from '../src/formats/imageDraw.ts';
import { readSvg } from '../src/vector/svgRead.ts';

/** A PNG's signature and header, enough to be told a picture's type and size. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const ALONE: Collaboration = { shared: false, people: [], count: 1 };

function setup(overrides: Partial<AppToolsHost> = {}) {
  const document = {};
  let shapes: Shape[] = [];
  const log: string[] = [];
  let collab: Collaboration = ALONE;
  const host = {
    current: () => document,
    documentName: () => 'Doc',
    agent: async () => 'worker',
    isPicture: () => true,
    pictureBytes: async () => png(400, 300),
    changePicture: async (edit: { op: string }) => void log.push(`change ${edit.op}`),
    pictureShapes: () => shapes,
    setPictureShapes: async (next: Shape[]) => void (shapes = next),
    sharedLive: () => false,
    textDrawings: () => [{ page: 1, width: 480, height: 320 }, { page: 2, width: 100, height: 100, embed: 'Sketch.svg' }],
    openTextDrawing: async (i: number) => (log.push(`open ${i}`), i > 1 ? 'there is no drawing' : null),
    closeTextDrawing: async () => (log.push('close'), null),
    insertTextDrawing: async (size: { width?: number; height?: number }) => (log.push(`insert ${size.width ?? '-'}x${size.height ?? '-'}`), null),
    collaboration: () => collab,
    drawing: async () => ({ drawing: readSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') }),
    ...overrides,
  } as unknown as AppToolsHost;
  const tools = appTools(host);
  const request = new AbortController().signal;
  tools.begin(request);
  const run = async (name: string, args: object = {}) => {
    const result = await tools.run(name, JSON.stringify(args), request);
    return typeof result === 'string' ? result : result.text;
  };
  return { run, log, get shapes() { return shapes; }, set collab(c: Collaboration) { collab = c; } };
}

test('draw adds a shape as a layer with an id, and layers lists the shapes back to front', async () => {
  const t = setup();
  assert.match(await t.run('edit_picture', { op: 'draw', tool: 'line', x: 10, y: 20, to_x: 100, to_y: 20, color: '#00aa00' }), /Done: draw line as shape 0/);
  await t.run('edit_picture', { op: 'draw', tool: 'text', x: 50, y: 60, text: 'hi' });
  assert.equal(t.shapes.length, 2);
  assert.ok(t.shapes.every((s) => s.id), 'every shape has an id');
  assert.deepEqual(t.log, [], 'the picture itself is not changed');
  const listed = await t.run('edit_picture', { op: 'layers' });
  assert.match(listed, /^0: line from \(10, 20\) to \(100, 20\); #00aa00/);
  assert.match(listed, /1: text at \(50, 60\);.*"hi"/);
});

test('a shape is erased or moved by its number, and flatten puts the shapes into the picture', async () => {
  const t = setup();
  await t.run('edit_picture', { op: 'draw', tool: 'line', x: 10, y: 10, to_x: 50, to_y: 10 });
  await t.run('edit_picture', { op: 'draw', tool: 'rectangle', x: 20, y: 20, to_x: 80, to_y: 60 });
  await t.run('edit_picture', { op: 'move_shape', number: 1, dx: 5, dy: -5 });
  assert.deepEqual(t.shapes[1].points, [{ x: 25, y: 15 }, { x: 85, y: 55 }]);
  await t.run('edit_picture', { op: 'erase_shape', number: 0 });
  assert.deepEqual(t.shapes.map((s) => s.tool), ['rectangle']);
  assert.match(await t.run('edit_picture', { op: 'flatten' }), /in the picture now/);
  assert.deepEqual(t.log, ['change draw']);
  const empty = setup();
  assert.match(await empty.run('edit_picture', { op: 'flatten' }), /no shapes/);
  assert.match(await empty.run('edit_picture', { op: 'erase_shape', number: 0 }), /no shapes/);
});

test('while others edit the picture, drawing and layers work and changes to the picture itself are refused', async () => {
  const t = setup({ sharedLive: () => true });
  assert.match(await t.run('edit_picture', { op: 'draw', tool: 'ellipse', x: 10, y: 10, to_x: 60, to_y: 40 }), /Done: draw/);
  assert.match(await t.run('edit_picture', { op: 'layers' }), /ellipse/);
  for (const args of [{ op: 'rotate_left' }, { op: 'crop', x: 0, y: 0, width: 10, height: 10 }, { op: 'grayscale' }, { op: 'resize', width: 10, height: 10 }, { op: 'flatten' }]) {
    assert.match(await t.run('edit_picture', args), /Error: others are editing this picture now/, JSON.stringify(args));
  }
  assert.deepEqual(t.log, [], 'nothing was changed');
});

test('drawings in the text are listed, inserted, opened and closed, and the reasons they cannot be come back as errors', async () => {
  const t = setup();
  assert.equal(await t.run('list_text_drawings'), '0: page 1, 480 x 320 px\n1: page 2, 100 x 100 px, embedded from "Sketch.svg"');
  assert.match(await t.run('insert_text_drawing', { width: 300, height: 200 }), /Inserted a blank drawing/);
  assert.match(await t.run('open_text_drawing', { number: 1 }), /Opened drawing 1/);
  assert.match(await t.run('open_text_drawing', { number: 5 }), /^Error: there is no drawing/);
  assert.equal(await t.run('close_text_drawing'), 'The drawing is back in the text.');
  assert.deepEqual(t.log, ['insert 300x200', 'open 1', 'open 5', 'close']);
  const none = setup({ textDrawings: () => [] });
  assert.match(await none.run('list_text_drawings'), /no drawings in the text/);
  const refused = setup({ insertTextDrawing: async () => 'a drawing cannot be added to a Markdown note while others are editing it.' });
  assert.match(await refused.run('insert_text_drawing'), /^Error: a drawing cannot be added to a Markdown note/);
  assert.match(await setup().run('insert_text_drawing', { width: 5 }), /^Error: `width` must be/);
});

test('collaboration says who is here, and that everyone edits at once', async () => {
  const t = setup();
  assert.equal(await t.run('collaboration_status'), 'Nobody else is editing this document now.');
  t.collab = { shared: true, people: ['Ann', 'Ben (you)'], count: 2 };
  assert.equal(await t.run('collaboration_status'), 'Editing now: Ann, Ben (you). Everyone can edit at once.');
  t.collab = { shared: true, people: [], count: 3 };
  assert.equal(await t.run('collaboration_status'), '3 people are editing now. Everyone can edit at once.');
});

test('once another document is open, a tool on the open document is refused, and one about other documents is not', async () => {
  let open: object = {};
  const t = setup({ current: () => open });
  open = {};
  assert.match(await t.run('edit_picture', { op: 'draw', tool: 'line', x: 1, y: 1, to_x: 9, to_y: 9 }), /no longer open/);
  assert.match(await t.run('get_document_info'), /no longer open/);
  assert.match(await t.run('set_view', { mode: 'pages' }), /no longer open/);
  assert.equal(t.shapes.length, 0, 'nothing was drawn on the other document');
  assert.doesNotMatch(await t.run('set_drawing_options', {}), /no longer open/);
});
