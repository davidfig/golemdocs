// A drawing as objects for editing it together (src/vector/nodes.ts, src/layout/vectorLayers.ts): the ranks that order nodes, the
// conversion that loses nothing, and people changing one drawing at once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollabServer } from '@golemdocs/ops';
import { ObjectSync } from '../src/layout/objectSync.ts';
import { VectorLayers } from '../src/layout/vectorLayers.ts';
import { assignRanks, ensureUids, objectsToScene, pathsByUid, rankBetween, ROOT, sceneToObjects } from '../src/vector/nodes.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { writeSvg } from '../src/vector/svgWrite.ts';
import type { Scene, SceneNode } from '../src/vector/model.ts';

const DRAWING = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <defs>
    <linearGradient id="fade"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
    <circle id="dot" r="4" fill="#333"/>
    <style>.big { stroke-width: 6 }</style>
  </defs>
  <rect id="back" x="10" y="10" width="120" height="80" fill="url(#fade)"/>
  <g id="pair" transform="translate(20 30)"><circle cx="150" cy="50" r="30" fill="#0a0"/><rect x="5" y="5" width="20" height="20" rx="3"/></g>
  <text x="20" y="150" font-size="14">Hello <tspan fill="#c00">there</tspan></text>
  <use href="#dot" x="300" y="100"/>
  <path d="M 10 180 L 90 180 L 50 120 Z" fill="none" stroke="#000" stroke-width="2"/>
  <foreignObject x="0" y="0" width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
</svg>`;

const kinds = (nodes: SceneNode[]): string[] => nodes.map((n) => (n.kind === 'group' ? `g(${kinds(n.children).join(',')})` : n.kind));

// --- Ranks ---------------------------------------------------------------------------------------------

test('a rank can always be found between two others, however many are put in the same place', () => {
  assert.equal(rankBetween(null, null), 'i');
  const ranks: string[] = [];
  // 300 nodes each put in a random place, as people moving and adding would.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 300; n++) {
    const at = Math.floor(random() * (ranks.length + 1));
    const rank = rankBetween(ranks[at - 1] ?? null, ranks[at] ?? null);
    assert.ok((ranks[at - 1] ?? '') < rank && (ranks[at] === undefined || rank < ranks[at]), `${ranks[at - 1]} < ${rank} < ${ranks[at]}`);
    assert.ok(!rank.endsWith('0'), 'never ends in 0, or there would be no room below');
    ranks.splice(at, 0, rank);
  }
  assert.deepEqual([...ranks].sort(), ranks, 'they stay in the order they were put in');
  // Always at the end, always at the start.
  let last: string | null = null;
  for (let n = 0; n < 60; n++) {
    const next = rankBetween(last, null);
    assert.ok(last === null || next > last);
    last = next;
  }
  let first: string | null = 'i';
  for (let n = 0; n < 60; n++) {
    const next = rankBetween(null, first);
    assert.ok(next < first!);
    first = next;
  }
  assert.throws(() => rankBetween('b', 'a'));
});

test('siblings keep the ranks they had while they keep their order, and the others get ones between their neighbours’', () => {
  assert.deepEqual(assignRanks([null, null, null]).length, 3);
  const fresh = assignRanks([null, null, null]);
  assert.deepEqual([...fresh].sort(), fresh);
  const [a, b, c] = fresh;
  // One new between two old ones: the old are as they were.
  const between = assignRanks([a!, null, c!]);
  assert.equal(between[0], a);
  assert.equal(between[2], c);
  assert.ok(between[1]! > a! && between[1]! < c!);
  // One moved from the end to the start: it gets a rank before the others, the others keep theirs.
  const moved = assignRanks([null, a!, b!]);
  assert.deepEqual(moved.slice(1), [a, b]);
  assert.ok(moved[0]! < a!);
  // Order reversed: still strictly increasing.
  const reversed = assignRanks([c!, b!, a!]);
  assert.deepEqual([...reversed].sort(), reversed);
  assert.equal(new Set(reversed).size, 3);
});

// --- Conversion -------------------------------------------------------------------------------------------

test('a drawing becomes objects and comes back as the same SVG, with ids on the nodes', () => {
  const scene = readSvg(DRAWING);
  const text = writeSvg(scene);
  const objects = sceneToObjects(scene);
  assert.equal(objects.nodes.length, 8, 'every node including those in the group');
  assert.ok(objects.nodes.every((n) => n.id && n.rank && n.parent), 'each has an id, a parent and a rank');
  assert.equal(objects.nodes.filter((n) => n.parent === ROOT).length, 6);
  // The file's own `defs` element is one object (named by what it holds); what the editor adds later are objects of their own, named by their id.
  assert.equal(objects.defs.length, 1);
  assert.match(objects.defs[0]!.id, /^~/);
  scene.defs.push({ name: 'linearGradient', attrs: { id: 'g1' }, children: [] }, { name: 'clipPath', attrs: { id: 'c1' }, children: [] });
  assert.deepEqual(sceneToObjects(scene).defs.map((d) => d.id).slice(1), ['#g1', '#c1']);
  scene.defs.length = 1;
  const back = objectsToScene(objects);
  assert.equal(writeSvg(back), text, 'the same SVG');
  assert.deepEqual(kinds(back.children), kinds(scene.children));
  assert.deepEqual(Object.keys(back.defined), Object.keys(scene.defined), 'what `use` shows is worked out again');
  // The ids are the nodes' own, and stay through a round trip.
  assert.deepEqual([...pathsByUid(back).keys()].sort(), objects.nodes.map((n) => n.id).sort());
  assert.deepEqual(back.children.map((n) => n.uid), scene.children.map((n) => n.uid));
});

test('a copy of a node, which has the same id, is given its own, and ranks are kept for what did not move', () => {
  const scene = readSvg(DRAWING);
  const first = sceneToObjects(scene);
  scene.children.splice(1, 0, structuredClone(scene.children[0]!)); // duplicated, next to the original
  scene.children.push(scene.children.splice(0, 1)[0]!); // and the first sent to the back
  const second = sceneToObjects(scene, first);
  assert.equal(new Set(second.nodes.map((n) => n.id)).size, second.nodes.length, 'no two nodes share an id');
  const before = new Map(first.nodes.map((n) => [n.id, n.rank]));
  const kept = second.nodes.filter((n) => n.parent === ROOT && before.has(n.id) && before.get(n.id) === n.rank);
  assert.ok(kept.length >= 4, 'most nodes keep their rank: moving one does not change the rest');
  assert.equal(writeSvg(objectsToScene(second)), writeSvg(scene));
});

test('a node whose parent is gone goes to the top, and two groups put inside each other are broken the same way for everyone', () => {
  const objects = sceneToObjects(readSvg(DRAWING));
  const group = objects.nodes.find((n) => n.node.kind === 'group')!;
  const orphaned = { ...objects, nodes: objects.nodes.filter((n) => n.id !== group.id) };
  const scene = objectsToScene(orphaned);
  assert.equal(scene.children.length, 7, 'the group’s children are at the top now');
  assert.ok(!kinds(scene.children).some((k) => k.startsWith('g(')));

  // Two groups, each moved into the other.
  const two = readSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g id="a"><rect width="1" height="1"/></g><g id="b"><rect width="2" height="2"/></g></svg>');
  const nodes = sceneToObjects(two).nodes;
  const [a, b] = nodes.filter((n) => n.node.kind === 'group');
  const looped = [{ ...a!, parent: b!.id }, { ...b!, parent: a!.id }, ...nodes.filter((n) => n !== a && n !== b)];
  const one = objectsToScene({ ...sceneToObjects(two), nodes: looped });
  const other = objectsToScene({ ...sceneToObjects(two), nodes: [...looped].reverse() });
  assert.equal(writeSvg(one), writeSvg(other), 'the order the objects are read in does not matter');
  assert.equal(one.children.length, 1, 'one of the two is at the top, the other inside it');
});

// --- People drawing at once -------------------------------------------------------------------------------

function pair() {
  const start = readSvg(DRAWING);
  ensureUids(start);
  const server = new CollabServer();
  const people = ['ann', 'ben'].map((client) => {
    const layers = new VectorLayers(structuredClone(start));
    const sync = new ObjectSync(layers, client);
    const inbox: any[] = [];
    const connection = server.connect((m) => inbox.push(m));
    sync.connect((m) => void connection.submit(m), 0);
    return { layers, sync, inbox, scene: layers.scene, edit(change: (scene: Scene) => void) { const next = structuredClone(layers.scene); change(next); layers.set(next); sync.local(); } };
  });
  const deliver = () => {
    for (let round = 0; round < 10; round++) {
      let any = false;
      for (const p of people) for (const m of p.inbox.splice(0)) (any = true), p.sync.receive(m);
      if (!any) break;
    }
  };
  return { ann: people[0]!, ben: people[1]!, deliver };
}

const rect = (x: number): SceneNode => ({ kind: 'rect', x, y: 0, width: 5, height: 5, rx: 0, ry: 0, style: { fill: '#e53935' }, attrs: {} });

test('two people drawing at once keep everything, in an order everyone agrees on', () => {
  const { ann, ben, deliver } = pair();
  ann.edit((s) => s.children.push(rect(1)));
  ben.edit((s) => s.children.push(rect(2)));
  ann.edit((s) => (s.children[0] as { style: Record<string, string> }).style.fill = '#000'); // and a change to an old node
  deliver();
  const a = writeSvg(ann.layers.scene);
  assert.equal(a, writeSvg(ben.layers.scene), 'both end with the same drawing');
  assert.equal(ann.layers.scene.children.length, 8, 'six, and the two new ones');
  for (const p of [ann, ben]) assert.equal((p.layers.scene.children[0] as { style: Record<string, string> }).style.fill, '#000', 'the change to an old node reached both');
});

test('people changing different nodes both win; changing the same node ends with the later change', () => {
  const { ann, ben, deliver } = pair();
  ann.edit((s) => ((s.children[0] as { x: number }).x = 50));
  ben.edit((s) => ((s.children[1] as { transform?: unknown }).transform = [1, 0, 0, 1, 7, 7]));
  deliver();
  for (const p of [ann, ben]) {
    const [first, second] = p.layers.scene.children as unknown as { x: number; transform?: number[] }[];
    assert.equal(first.x, 50, 'ann’s change is there');
    assert.deepEqual(second.transform, [1, 0, 0, 1, 7, 7], 'and ben’s');
  }
  // The same node.
  ann.edit((s) => ((s.children[0] as { x: number }).x = 1));
  ben.edit((s) => ((s.children[0] as { x: number }).x = 2));
  deliver();
  assert.equal((ann.layers.scene.children[0] as { x: number }).x, (ben.layers.scene.children[0] as { x: number }).x, 'one of them, the same for both');
});

test('a node deleted by one while another draws in its group leaves the new node at the top, and moving a node reorders it for both', () => {
  const { ann, ben, deliver } = pair();
  const groupIndex = ann.layers.scene.children.findIndex((n) => n.kind === 'group');
  ann.edit((s) => s.children.splice(groupIndex, 1)); // the group is gone
  ben.edit((s) => (s.children[groupIndex] as unknown as { children: SceneNode[] }).children.push(rect(9))); // while ben draws in it
  deliver();
  assert.equal(writeSvg(ann.layers.scene), writeSvg(ben.layers.scene));
  assert.ok(ann.layers.scene.children.some((n) => n.kind === 'rect' && (n as { x: number }).x === 9), 'ben’s node is not lost');

  // Sent to the back by ben: ann sees the new order.
  ben.edit((s) => s.children.unshift(s.children.pop()!));
  deliver();
  assert.equal(writeSvg(ann.layers.scene), writeSvg(ben.layers.scene));
  assert.equal(ann.layers.scene.children[0]!.uid, ben.layers.scene.children[0]!.uid);
});

test('undo takes back only one’s own change, and a change to the page settings travels too', () => {
  const { ann, ben, deliver } = pair();
  ann.edit((s) => s.children.push(rect(1)));
  ben.edit((s) => s.children.push(rect(2)));
  deliver();
  ben.sync.undo();
  ben.layers.scene; // read back
  deliver();
  const xs = (p: typeof ann) => p.layers.scene.children.filter((n) => n.kind === 'rect').map((n) => (n as { x: number }).x);
  assert.ok(xs(ann).includes(1) && !xs(ann).includes(2), 'ben’s node is gone, ann’s is not');
  assert.deepEqual(xs(ann), xs(ben));
  ann.edit((s) => ((s.width = 800), (s.viewBox = { ...s.viewBox, width: 800 })));
  deliver();
  assert.equal(ben.layers.scene.width, 800);
  assert.equal(ben.layers.scene.viewBox.width, 800);
});

test('two people each adding a gradient both keep it, and a node using one is not left without it', () => {
  const { ann, ben, deliver } = pair();
  const gradient = (id: string) => ({ name: 'linearGradient', attrs: { id }, children: [] });
  ann.edit((s) => {
    s.defs.push(gradient('ann'));
    (s.children[0] as { style: Record<string, string> }).style.fill = 'url(#ann)';
  });
  ben.edit((s) => {
    s.defs.push(gradient('ben'));
    (s.children[1] as { style: Record<string, string> }).style.fill = 'url(#ben)';
  });
  deliver();
  for (const p of [ann, ben]) {
    const text = writeSvg(p.layers.scene);
    assert.match(text, /id="ann"/);
    assert.match(text, /id="ben"/);
    assert.match(text, /url\(#ann\)/);
    assert.match(text, /url\(#ben\)/);
  }
});
