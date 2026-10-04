import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layersOf, applyObjectOps, diffObjects, invertObjectOps, isObjectOp, objectOps, objectTransaction, ObjectReplica, type ClientMessage, type ObjectLayers, type ObjectOp, type ServerMessage } from '../src/index.ts';

const item = (id: string, text = id): { id: string; text: string } => ({ id, text });
const layers = (annotations: { id: string; text: string }[] = [], fields: { id: string; text: string }[] = [], edits: { id: string; text: string }[] = [], shapes: { id: string; text: string }[] = []): ObjectLayers<{ id: string; text: string }> => layersOf({ annotations, fields, edits, shapes });

test('only a change to an object of a layer, with an id that is the object’s, is an object operation', () => {
  assert.equal(isObjectOp({ type: 'put', layer: 'annotations', id: 'a', value: { id: 'a', x: 1 } }), true);
  assert.equal(isObjectOp({ type: 'del', layer: 'edits', id: 'e' }), true);
  assert.equal(isObjectOp({ type: 'put', layer: 'shapes', id: 's', value: { id: 's', tool: 'pen' } }), true, 'a picture’s shapes are objects too');
  for (const bad of [null, 'x', {}, { type: 'put', layer: 'nope', id: 'a', value: { id: 'a' } }, { type: 'put', layer: 'fields', id: 'a', value: { id: 'b' } }, { type: 'put', layer: 'fields', id: 'a', value: [] }, { type: 'put', layer: 'fields', id: '', value: { id: '' } }, { type: 'del', layer: 'fields' }, { type: 'move', layer: 'fields', id: 'a' }]) {
    assert.equal(isObjectOp(bad), false, JSON.stringify(bad));
  }
  assert.equal(isObjectOp({ type: 'put', layer: 'edits', id: 'big', value: { id: 'big', data: 'x'.repeat(4 * 1024 * 1024) } }), false, 'too much for one change');
});

test('a put replaces an object where it is or adds it last, a del removes it, and untouched layers are the same lists', () => {
  const start = layers([item('a'), item('b')], [item('f')]);
  const { layers: next, changed } = applyObjectOps(start, [
    { type: 'put', layer: 'annotations', id: 'a', value: item('a', 'changed') },
    { type: 'put', layer: 'annotations', id: 'c', value: item('c') },
    { type: 'del', layer: 'annotations', id: 'b' },
    { type: 'del', layer: 'annotations', id: 'missing' },
  ]);
  assert.deepEqual(next.annotations, [item('a', 'changed'), item('c')]);
  assert.equal(next.fields, start.fields);
  assert.equal(next.edits, start.edits);
  assert.deepEqual(start.annotations, [item('a'), item('b')], 'the lists given are not changed');
  assert.deepEqual(changed.map((c) => [c.before?.id, c.after?.id]), [['a', 'a'], [undefined, 'c'], ['b', undefined], [undefined, undefined]]);
});

test('what differs between two states is the changes that turn one into the other', () => {
  const from = layers([item('a'), item('b'), item('c')], [item('f', 'one')]);
  const to = layers([item('a'), item('c', 'new'), item('d')], [item('f', 'one')]);
  const ops = diffObjects(from, to);
  assert.deepEqual(ops.map((o) => `${o.type} ${o.layer} ${o.id}`).sort(), ['del annotations b', 'put annotations c', 'put annotations d']);
  assert.deepEqual(applyObjectOps(from, ops).layers.annotations.map((o) => o.id).sort(), ['a', 'c', 'd']);
  assert.deepEqual(diffObjects(from, from), []);
});

test('the inverse of changes puts back what they changed, and takes out what they added', () => {
  const start = layers([item('a'), item('b')]);
  const ops: ObjectOp[] = [
    { type: 'put', layer: 'annotations', id: 'a', value: item('a', 'x') },
    { type: 'put', layer: 'annotations', id: 'a', value: item('a', 'y') },
    { type: 'del', layer: 'annotations', id: 'b' },
    { type: 'put', layer: 'annotations', id: 'n', value: item('n') },
  ];
  const after = applyObjectOps(start, ops).layers;
  const back = applyObjectOps(after, invertObjectOps(start, ops)).layers;
  assert.deepEqual([...back.annotations].sort((x, y) => x.id.localeCompare(y.id)), [item('a'), item('b')]);
});

// --- The replica ----------------------------------------------------------------------------------------

function replica(version = 0) {
  const sent: ClientMessage[] = [];
  let state = layers();
  const applied: { ops: ObjectOp[]; remote: boolean }[] = [];
  const r = new ObjectReplica((m) => sent.push(m), version, (ops, remote) => {
    state = applyObjectOps(state, ops).layers;
    applied.push({ ops: [...ops], remote });
  });
  const local = (id: string, ...ops: ObjectOp[]) => {
    state = applyObjectOps(state, ops).layers;
    r.commit(objectTransaction(id, id.split(':')[0]!, ops));
  };
  return { r, sent, applied, local, get state() { return state; } };
}
const put = (id: string, text = id): ObjectOp => ({ type: 'put', layer: 'annotations', id, value: item(id, text) });
const server = (version: number, ...txs: ReturnType<typeof objectTransaction>[]): ServerMessage => ({ type: 'transactions', version, transactions: txs });

test('a change is submitted at once, the next waits for the answer, and the room’s copy of ours is the answer', () => {
  const t = replica();
  t.local('me:0', put('a'));
  assert.equal(t.sent.length, 1);
  assert.equal(t.r.unconfirmed, 1);
  t.local('me:1', put('b'));
  assert.equal(t.sent.length, 1, 'one in flight at a time');
  t.r.receive(server(0, objectTransaction('me:0', 'me', [put('a')])));
  assert.equal(t.r.version, 1);
  assert.equal(t.sent.length, 2, 'the next goes now');
  assert.deepEqual((t.sent[1] as any).transactions.map((x: any) => x.id), ['me:1']);
  assert.equal((t.sent[1] as any).version, 1);
  t.r.receive(server(1, objectTransaction('me:1', 'me', [put('b')])));
  assert.equal(t.r.unconfirmed, 0);
  assert.deepEqual(t.applied, [], 'nothing of others’');
});

test('changes from others are applied, then ours again over them, and ours are submitted again against the new version', () => {
  const t = replica();
  t.local('me:0', put('x', 'mine'));
  // Someone else changed the same object first: the room put theirs before ours.
  t.r.receive(server(0, objectTransaction('you:0', 'you', [put('x', 'theirs'), put('y')])));
  assert.deepEqual(t.state.annotations, [item('x', 'mine'), item('y')], 'ours wins, as it will in the room');
  assert.deepEqual(t.applied.map((a) => a.remote), [true, false]);
  assert.equal(t.r.version, 1);
  assert.equal(t.sent.length, 2);
  assert.equal((t.sent[1] as any).version, 1);
  assert.deepEqual((t.sent[1] as any).transactions.map((x: any) => x.id), ['me:0']);
  t.r.receive(server(1, objectTransaction('me:0', 'me', [put('x', 'mine')])));
  assert.equal(t.r.unconfirmed, 0);
});

test('after reconnecting, what was already in the room’s log is confirmed and not applied again', () => {
  const t = replica();
  t.local('me:0', put('a'));
  t.r.resubmit();
  const sentBefore = t.sent.length;
  // The room had it all along, behind someone else’s change.
  t.r.receive(server(0, objectTransaction('you:0', 'you', [put('z')]), objectTransaction('me:0', 'me', [put('a')])));
  assert.equal(t.r.unconfirmed, 0, 'confirmed');
  assert.equal(t.r.version, 2);
  assert.deepEqual(t.applied.flatMap((a) => a.ops.map((o) => o.id)), ['z'], 'only the other’s change is applied');
  assert.equal(t.sent.length, sentBefore, 'nothing left to send');
});

test('a gap in what the room sends is an error, and what was already known is skipped', () => {
  const t = replica(2);
  assert.throws(() => t.r.receive(server(5, objectTransaction('you:0', 'you', [put('a')]))), /missed/);
  t.r.receive(server(0, objectTransaction('old:0', 'old', [put('o')]), objectTransaction('old:1', 'old', [put('p')]), objectTransaction('you:5', 'you', [put('n')])));
  assert.deepEqual(t.applied.flatMap((a) => a.ops.map((o) => o.id)), ['n']);
  assert.equal(t.r.version, 3);
  assert.deepEqual(objectOps(objectTransaction('t', 'c', [put('a')])).map((o) => o.id), ['a']);
});
