// A picture's layers: the shapes drawn over it, kept apart from its pixels (src/layout/pictureLayers.ts), their history, and how they are
// put into the picture when it is written out (src/formats/handlers/image.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollabServer } from '@golemdocs/ops';
import { ObjectSync } from '../src/layout/objectSync.ts';
import { PictureLayers, withId } from '../src/layout/pictureLayers.ts';
import type { Shape } from '../src/formats/imageDraw.ts';
import { readWdoc, writeWdoc } from '../src/formats/wdoc.ts';

const line = (id: string, x = 0): Shape => ({ id, tool: 'line', color: '#e5322d', width: 4, points: [{ x, y: 0 }, { x: x + 10, y: 0 }] });

test('a shape without an id is given one, and one that has an id keeps it', () => {
  const made = withId({ tool: 'pen', color: '#000', width: 2, points: [{ x: 0, y: 0 }] });
  assert.match(made.id, /^[0-9a-f-]{12}$/);
  assert.equal(withId(line('mine')).id, 'mine');
  const layers = new PictureLayers([{ tool: 'pen', color: '#000', width: 2, points: [] }, line('b')]);
  assert.equal(layers.shapes.length, 2);
  assert.ok(layers.shapes.every((s) => s.id));
});

test('changes to the shapes by id put objects in, take them out and leave the rest', () => {
  const layers = new PictureLayers([line('a'), line('b')]);
  const parts = layers.applyObjects([
    { type: 'put', layer: 'shapes', id: 'c', value: line('c') as { id: string } },
    { type: 'del', layer: 'shapes', id: 'a' },
  ]);
  assert.deepEqual(parts, [0]);
  assert.deepEqual(layers.shapes.map((s) => s.id), ['b', 'c']);
  assert.deepEqual(layers.applyObjects([]), []);
  assert.deepEqual(layers.applyObjects([{ type: 'del', layer: 'shapes', id: 'nothing' }]), [0], 'a change that changes nothing still names the part');
});

test('alone, undo and redo step over the person’s own changes, one drawing step at a time', () => {
  const layers = new PictureLayers();
  const sync = new ObjectSync(layers, 'me');
  layers.set([line('a')]);
  sync.local();
  layers.set([line('a'), line('b')]);
  sync.local();
  layers.set([line('a', 5), line('b')]); // moved
  sync.local();
  assert.equal(sync.canUndo, true);
  sync.undo();
  assert.deepEqual(layers.shapes.map((s) => [s.id, s.points[0].x]), [['a', 0], ['b', 0]], 'the move is taken back');
  sync.undo();
  assert.deepEqual(layers.shapes.map((s) => s.id), ['a']);
  sync.redo();
  assert.deepEqual(layers.shapes.map((s) => s.id), ['a', 'b']);
  layers.set([line('a'), line('b'), line('c')]);
  sync.local();
  assert.equal(sync.canRedo, false, 'a new change ends what could be redone');
  sync.reset();
  assert.equal(sync.canUndo, false);
});

test('two people drawing at once end with every shape, and one’s undo takes back only their own', () => {
  const server = new CollabServer();
  const make = (client: string) => {
    const inbox: any[] = [];
    const layers = new PictureLayers();
    const sync = new ObjectSync(layers, client);
    const connection = server.connect((m) => inbox.push(m));
    sync.connect((m) => void connection.submit(m), 0);
    return { layers, sync, inbox };
  };
  const ann = make('ann');
  const ben = make('ben');
  const deliver = () => {
    for (let round = 0; round < 10; round++) {
      let any = false;
      for (const p of [ann, ben]) for (const m of p.inbox.splice(0)) (any = true), p.sync.receive(m);
      if (!any) break;
    }
  };
  ann.layers.set([line('ann1')]);
  ann.sync.local();
  ben.layers.set([line('ben1')]);
  ben.sync.local();
  deliver();
  const ids = (p: typeof ann) => p.layers.shapes.map((s) => s.id).sort();
  assert.deepEqual(ids(ann), ['ann1', 'ben1']);
  assert.deepEqual(ids(ben), ['ann1', 'ben1']);
  ben.sync.undo();
  deliver();
  assert.deepEqual(ids(ann), ['ann1']);
  assert.deepEqual(ids(ben), ['ann1']);
  assert.equal(ann.sync.canUndo, true, 'ann’s own change can still be undone');
});

test('a picture’s shapes are kept in its extension in a .wdoc and come back', async () => {
  const shapes = [line('a'), { ...line('t'), tool: 'text' as const, text: 'hi' }];
  const bytes = await writeWdoc({ manifest: { version: 1, lens: 'png', origin: 'png', pagesCurrent: false }, document: new Uint8Array([1, 2, 3]), original: null, extensions: { img: { shapes } } });
  const read = await readWdoc(bytes);
  assert.deepEqual(read.extensions.img?.shapes, shapes);
  assert.equal(read.manifest.lens, 'png');
});

test('shapes changed from an older list (a drag while others drew) keep what others did meanwhile', () => {
  const server = new CollabServer();
  const make = (client: string) => {
    const inbox: any[] = [];
    const layers = new PictureLayers([line('a'), line('b')]);
    const sync = new ObjectSync(layers, client);
    const connection = server.connect((m) => inbox.push(m));
    sync.connect((m) => void connection.submit(m), 0);
    return { layers, sync, inbox };
  };
  const ann = make('ann');
  const ben = make('ben');
  const deliver = () => {
    for (let round = 0; round < 10; round++) {
      let any = false;
      for (const p of [ann, ben]) for (const m of p.inbox.splice(0)) (any = true), p.sync.receive(m);
      if (!any) break;
    }
  };
  // Ann starts moving a; meanwhile Ben draws c and erases b.
  const base = [...ann.layers.shapes];
  ben.layers.set([line('a'), line('c')]);
  ben.sync.local();
  deliver();
  const moved = [line('a', 5), line('b')];
  assert.equal(ann.sync.localFrom(PictureLayers.objectsOf(base), PictureLayers.objectsOf(moved), () => ann.layers.set(moved)), true);
  deliver();
  for (const p of [ann, ben]) assert.deepEqual(p.layers.shapes.map((s) => [s.id, s.points[0].x]), [['a', 5], ['c', 0]], 'the move, ben’s new shape, and b still erased');
  ann.sync.undo();
  deliver();
  assert.deepEqual(ben.layers.shapes.map((s) => [s.id, s.points[0].x]), [['a', 0], ['c', 0]], 'her undo takes back only the move');
});

test('shapes changed from the list the picture still has are kept in the order given (a layer moved)', () => {
  const layers = new PictureLayers([line('a'), line('b'), line('c')]);
  const sync = new ObjectSync(layers, 'me');
  const base = [...layers.shapes];
  const reordered = [line('c'), line('a'), line('b')];
  assert.equal(sync.localFrom(PictureLayers.objectsOf(base), PictureLayers.objectsOf(reordered), () => layers.set(reordered)), false);
  assert.deepEqual(layers.shapes.map((s) => s.id), ['c', 'a', 'b']);
});
