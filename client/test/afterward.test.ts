// Afterward (docs/afterward.md), the editor in the margin: the text it reads, finding notes and quotes again, the answers'
// shapes, the model call (streamed or not), and where the key is kept.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReaderText } from '../src/layout/protocol.ts';
import { agentOf, BOARD, readerAuthor } from '../src/afterward/authors.ts';
import { answerOf, directModel, errorOf, FAST_MODEL, ModelError, partialField, readStream, retryable, retryDelay } from '../src/afterward/model.ts';
import { ANSWER_SCHEMA, askTask, checkAnswer, checkOutline, checkQueries, checkQuotes, checkReadAlong, OUTLINE_SCHEMA, QUERIES_SCHEMA, QUOTES_SCHEMA, READ_ALONG_SCHEMA, readAlongTask, ShapeError, system } from '../src/afterward/prompts.ts';
import { KEY_SETTING } from '../src/afterward/record.ts';
import { chaptersOf, cutRange, findQuote, fingerprint, LONG_WORDS, locateNote, numbered, PART_WORDS, scopeOf, pieceOf, selectedPassage, trimSources, verifyQuote } from '../src/afterward/text.ts';
import { SYNCED_KEYS } from '../src/settingsSync.ts';

const O = '￼';
const para = (text: string, heading = 0, table = false): ReaderText['paragraphs'][number] => ({ text, heading, table, place: null });

const DOC: ReaderText = {
  paragraphs: [
    para('A Title', 1),
    para('The first “real” paragraph — it starts slowly.'),
    para(''),
    para(`Second${O} paragraph with a marker${O} in it.`),
    para('cell', 0, true),
    para('References', 2),
    para('Smith, J. (2020).'),
  ],
  comments: [{ id: '7', start: [3, 0], end: [3, 7] }],
  selection: null,
};

test('the piece is the prose: headings marked, empty lines, tables and the references left out', () => {
  const piece = pieceOf(DOC);
  assert.deepEqual(
    piece.paragraphs.map((p) => [p.n, p.index]),
    [
      [1, 1],
      [2, 3],
    ],
  );
  assert.equal(numbered(piece), '## A Title\n\n[1] The first “real” paragraph — it starts slowly.\n\n[2] Second paragraph with a marker in it.');
});

test('a quote is found exactly, or ignoring quotes, dashes, case, spacing and objects; its offsets are model offsets', () => {
  const text = DOC.paragraphs[1].text;
  assert.deepEqual(findQuote(text, 'it starts slowly'), [text.indexOf('it starts'), text.length - 1]);
  // Straight quotes and a hyphen for the curly quotes and dash.
  const loose = findQuote(text, '"real" paragraph - it STARTS');
  assert.ok(loose);
  assert.equal(text.slice(loose[0], loose[1]), '“real” paragraph — it starts');
  // A marker inside the quoted words is skipped, and stays inside the range.
  const marked = DOC.paragraphs[3].text;
  const at = findQuote(marked, 'Second paragraph');
  assert.deepEqual(at, [0, marked.indexOf('paragraph') + 'paragraph'.length]);
  // Cut short with "...".
  const cut = findQuote(text, 'The first ... slowly');
  assert.deepEqual(cut, [0, text.length - 1]);
  assert.equal(findQuote(text, 'not in the text'), null);
});

test('fingerprints follow the visible text, not the markers', () => {
  assert.equal(fingerprint(`Second${O} paragraph`), fingerprint('Second paragraph'));
  assert.notEqual(fingerprint('Second paragraph'), fingerprint('Second paragraph!'));
});

test("a reader's comments are signed so they read as the reader's in any file", () => {
  assert.deepEqual(agentOf(readerAuthor('The editor')), { name: 'The editor', board: false });
  assert.deepEqual(agentOf(BOARD), { name: BOARD, board: true });
  assert.equal(agentOf('Ada Lovelace'), null);
  assert.equal(agentOf(' · Afterward'), null);
});

test('every schema is strict: every object closed and every property required', () => {
  const walk = (schema: Record<string, unknown>): void => {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      assert.deepEqual(schema.required, Object.keys(properties));
      for (const p of Object.values(properties)) walk(p);
    }
    if (schema.type === 'array') walk(schema.items as Record<string, unknown>);
  };
  for (const schema of [READ_ALONG_SCHEMA, ANSWER_SCHEMA, OUTLINE_SCHEMA, QUERIES_SCHEMA, QUOTES_SCHEMA]) walk(schema);
});

test('the direct call sends the key only to Anthropic, asks for structured output, and reads the JSON back', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"replies":[]}' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const answer = await directModel('sk-test', { model: 'claude-opus-5-5', fetch: fake }).ask({ system: [{ type: 'text', text: 'rules' }], task: 'task', schema: ANSWER_SCHEMA, effort: 'medium' });
  assert.deepEqual(answer, { replies: [] });
  const sent = seen as unknown as { url: string; init: RequestInit };
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  const headers = sent.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  const body = JSON.parse(sent.init.body as string);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.output_config, { effort: 'medium', format: { type: 'json_schema', schema: ANSWER_SCHEMA } });
  assert.deepEqual(body.messages, [{ role: 'user', content: 'task' }]);
  assert.equal(body.fallbacks, 'default');
});

test('failures become kinds the app explains', async () => {
  assert.equal(errorOf(401, null).kind, 'key');
  assert.equal(errorOf(429, null).kind, 'rate');
  assert.equal(errorOf(529, null).kind, 'overloaded');
  assert.equal(errorOf(500, { error: { message: 'boom' } }).message, 'boom');
  assert.throws(() => answerOf({ stop_reason: 'refusal', content: [] }), (e: unknown) => e instanceof ModelError && e.kind === 'refused');
  assert.throws(() => answerOf({ stop_reason: 'max_tokens', content: [] }), (e: unknown) => e instanceof ModelError && e.kind === 'tooLong');
  assert.throws(() => answerOf({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), (e: unknown) => e instanceof ModelError && e.kind === 'shape');
  const offline = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  await assert.rejects(directModel('k', { fetch: offline, sleep: async () => {} }).ask({ system: [], task: '', schema: {}, effort: 'low' }), (e: unknown) => e instanceof ModelError && e.kind === 'network');
});

/** A fetch that answers with each of `replies` in turn (a status, or a thrown network error), counting the calls. */
function scripted(replies: (number | 'offline')[], headers: Record<string, string> = {}) {
  const calls: number[] = [];
  const fetchFn = (async () => {
    const next = replies[calls.length] ?? 200;
    calls.push(calls.length);
    if (next === 'offline') throw new TypeError('Failed to fetch');
    const body = next === 200 ? { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] } : { error: { message: `status ${next}` } };
    return new Response(JSON.stringify(body), { status: next, headers });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const request = { system: [], task: '', schema: {}, effort: 'low' as const };

test('a failure that may pass is tried again, twice, after a wait that grows', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const flaky = scripted([529, 'offline']);
  assert.deepEqual(await directModel('k', { fetch: flaky.fetchFn, sleep }).ask(request), { ok: true });
  assert.equal(flaky.calls.length, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 375 && waits[0] <= 500 && waits[1] >= 750 && waits[1] <= 1000, String(waits));
  // Still failing after two more tries: the error is the last one.
  const down = scripted([529, 529, 529, 200]);
  await assert.rejects(directModel('k', { fetch: down.fetchFn, sleep }).ask(request), (e: unknown) => e instanceof ModelError && e.kind === 'overloaded');
  assert.equal(down.calls.length, 3);
});

test('what cannot pass is not tried again: a bad key, a bad request, or the API saying not to', async () => {
  const sleep = async () => {};
  for (const status of [400, 401, 403, 404, 413]) {
    const once = scripted([status]);
    await assert.rejects(directModel('k', { fetch: once.fetchFn, sleep }).ask(request));
    assert.equal(once.calls.length, 1, String(status));
  }
  const told = scripted([500], { 'x-should-retry': 'false' });
  await assert.rejects(directModel('k', { fetch: told.fetchFn, sleep }).ask(request));
  assert.equal(told.calls.length, 1);
  assert.ok(retryable(429) && retryable(529) && retryable(408) && retryable(500) && !retryable(400) && !retryable(401));
});

test('the wait is what the API asks for, when it is reasonable', () => {
  assert.equal(retryDelay(1, new Headers({ 'retry-after-ms': '1500' })), 1500);
  assert.equal(retryDelay(1, new Headers({ 'retry-after': '3' })), 3000);
  // A minute or more is not waited for here: the usual backoff, at most 8 seconds.
  assert.equal(retryDelay(1, new Headers({ 'retry-after': '120' }), () => 0), 500);
  assert.equal(retryDelay(9, null, () => 0), 8000);
});

test('Stop during a wait stops at once', async () => {
  const abort = new AbortController();
  const busy = scripted([429, 429, 429]);
  const asked = directModel('k', { fetch: busy.fetchFn }).ask(request, abort.signal);
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(asked, (e: unknown) => e instanceof ModelError && e.kind === 'stopped');
  assert.equal(busy.calls.length, 1);
});

const SOURCES = [
  { name: 'Smith 2020 - Floods', paragraphs: ['Rivers rose 3 metres in 48 hours, the fastest rise on record.', 'The town had “no plan at all” for the evacuation.'] },
  { name: 'Interview notes', paragraphs: ['She said the water came up through the floorboards before anyone saw the river move.'] },
];

test('a quote is shown only if it is in a source word for word, and in the source’s own words', () => {
  // Found in the source named, with the source's curly quotes kept although the model wrote straight ones.
  assert.deepEqual(verifyQuote(SOURCES, 0, 'The town had "no plan at all" for the evacuation.'), { source: 0, paragraph: 1, text: 'The town had “no plan at all” for the evacuation.' });
  // The wrong source named: found in the other one.
  assert.equal(verifyQuote(SOURCES, 0, 'the water came up through the floorboards')?.source, 1);
  // Invented, paraphrased, cut with an ellipsis, or too short: never shown.
  assert.equal(verifyQuote(SOURCES, 0, 'Rivers rose four metres in two days, the fastest rise ever.'), null);
  assert.equal(verifyQuote(SOURCES, 0, 'Rivers rose 3 metres ... the fastest rise on record.'), null);
  assert.equal(verifyQuote(SOURCES, 0, 'no plan'), null);
  assert.equal(verifyQuote(SOURCES, 7, 'Rivers rose 3 metres in 48 hours')?.source, 0);
});

test('the passage is the selection, or the paragraph at the caret', () => {
  const at = (start: [number, number], end: [number, number]) => selectedPassage({ ...DOC, selection: { start, end } });
  assert.deepEqual(at([1, 4], [1, 9]), { paragraph: 1, from: 4, to: 9, passage: 'first', around: visible1 });
  assert.deepEqual(at([1, 3], [1, 3]), { paragraph: 1, from: 0, to: DOC.paragraphs[1].text.length, passage: visible1, around: visible1 });
  // Over two paragraphs: commented on in the first, read whole.
  const across = at([1, 4], [3, 6]);
  assert.equal(across?.paragraph, 1);
  assert.equal(across?.to, DOC.paragraphs[1].text.length);
  assert.ok(across?.passage.startsWith('first') && across.passage.endsWith('Second'));
  assert.equal(selectedPassage({ ...DOC, selection: null }), null);
  assert.equal(at([2, 0], [2, 0]), null, 'an empty paragraph has nothing to quote for');
});
const visible1 = 'The first “real” paragraph — it starts slowly.';

test('sources are cut to whole paragraphs within the budget', () => {
  const big = [{ name: 'a', paragraphs: ['x'.repeat(10), 'y'.repeat(10), 'z'.repeat(10)] }, { name: 'b', paragraphs: ['w'.repeat(10)] }, { name: 'c', paragraphs: ['v'.repeat(50)] }];
  assert.deepEqual(
    trimSources(big, 25, 35).map((s) => [s.name, s.paragraphs.length]),
    [
      ['a', 2],
      ['b', 1],
    ],
  );
});

test('outlines, queries and quotes are checked like the rest', () => {
  assert.deepEqual(checkOutline({ paragraphs: [{ paragraph: 1, does: ' sets the scene ' }], point: 2, observations: ['', '1 and 3 do the same job'] }), {
    paragraphs: [{ paragraph: 1, does: 'sets the scene' }],
    point: 2,
    observations: ['1 and 3 do the same job'],
  });
  assert.throws(() => checkOutline({ paragraphs: [], point: '2', observations: [] }), ShapeError);
  assert.deepEqual(checkQueries({ queries: ['floods', ' ', 'evacuation plan', 'river', 'extra'] }), ['floods', 'evacuation plan', 'river']);
  assert.deepEqual(checkQuotes({ quotes: [{ source: 1, quote: 'q', why: 'w' }] }), [{ source: 1, quote: 'q', why: 'w' }]);
});

/** A long piece: a title, then chapters of `paras` paragraphs of `words` words each. */
function book(chapters: number, paras: number, words: number, headings = true): ReaderText {
  const paragraphs: ReaderText['paragraphs'] = [para('The Book', 1)];
  for (let c = 1; c <= chapters; c++) {
    if (headings) paragraphs.push(para(`Chapter ${c}`, 2));
    for (let p = 1; p <= paras; p++) paragraphs.push(para(`Chapter ${c} paragraph ${p} ${'word '.repeat(words - 4)}`.trim()));
  }
  return { paragraphs, comments: [], selection: null };
}

test('a long piece is read in chapters: the headings of the highest level that repeats, a lone title not counting', () => {
  const text = book(3, 10, 300);
  const chapters = chaptersOf(text);
  assert.deepEqual(
    chapters.map((c) => [c.title, c.from, c.to]),
    [
      ['Chapter 1', 1, 12],
      ['Chapter 2', 12, 23],
      ['Chapter 3', 23, 34],
    ],
  );
  assert.equal(chapters[0].words, 3000);
  // Prose before the first chapter is a chapter of its own (an opening), unnamed.
  const withPrologue: ReaderText = { ...text, paragraphs: [text.paragraphs[0], para('A prologue before it all.'), ...text.paragraphs.slice(1)] };
  assert.deepEqual(chaptersOf(withPrologue).map((c) => c.title).slice(0, 2), ['', 'Chapter 1']);
});

test('a long piece with no chapter headings is read in parts of about PART_WORDS words, between paragraphs', () => {
  const text = book(1, 30, 400, false);
  const parts = chaptersOf(text);
  assert.ok(parts.length >= 3);
  for (const part of parts.slice(0, -1)) assert.ok(part.words >= PART_WORDS && part.words < PART_WORDS + 400, String(part.words));
  assert.equal(parts[parts.length - 1].to, text.paragraphs.length);
});

test('a short piece is read whole; a long one, the chapter at the caret with the chapters before it', () => {
  assert.equal(scopeOf(DOC, 1).chapter, null);
  const text = book(3, 10, 300);
  assert.ok(3 * 10 * 300 > LONG_WORDS);
  const at = scopeOf(text, 15);
  assert.equal(at.chapter?.title, 'Chapter 2');
  assert.deepEqual(at.before.map((c) => c.title), ['Chapter 1']);
  // Numbering starts again in the chapter, and indexes stay the document's.
  const piece = pieceOf(text, at.range);
  assert.equal(piece.paragraphs[0].n, 1);
  assert.equal(piece.paragraphs[0].index, 13);
  assert.ok(piece.paragraphs.every((p) => p.text.startsWith('Chapter 2 ')));
});

test('a chapter is read knowing what came before and nothing after, each earlier chapter a block of its own', () => {
  const text = book(3, 10, 300);
  const at = scopeOf(text, 15);
  const piece = pieceOf(text, at.range);
  const blocks = system(piece, 'The Book', { title: 'Chapter 2', before: [{ title: 'Chapter 1', text: 'Chapter 1 text' }] });
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].text.includes('What you have read so far') && blocks[1].text.includes('# Chapter 1'));
  assert.equal(blocks[1].cache_control?.type, 'ephemeral');
  assert.ok(blocks[2].text.includes('The chapter you are reading now, "Chapter 2"') && blocks[2].text.includes("You don't know what comes after"));
  assert.ok(blocks[2].text.includes('[1] Chapter 2 paragraph 1'));
  assert.ok(!blocks.some((b) => b.text.includes('Chapter 3')), 'nothing after the chapter');
});


test('the API key never follows the account; reading along, a choice of behaviour, does', () => {
  assert.ok(!SYNCED_KEYS.includes(KEY_SETTING));
  assert.ok(!SYNCED_KEYS.some((k) => k.includes('afterward.key') || k.includes('afterward.review')));
  assert.ok(SYNCED_KEYS.includes('golem.afterward.readAlong'));
});

test('reading along: a sentence of reading, and at most three notes, each with a cut or words only when they fit', () => {
  const read = checkReadAlong({
    reads_as: ' An essay on procrastination. ',
    notes: [
      { paragraph: 2, quote: 'protective panacea', note: 'A panacea cures; it does not protect.', cut: '', words: ['refuge', 'lifeline', 'a whole new sentence of words'] },
      { paragraph: 3, quote: '', note: 'no quote', cut: '', words: [] },
      { paragraph: 4, quote: 'a', note: 'b', cut: 'c', words: [] },
      { paragraph: 5, quote: 'd', note: 'e', cut: '', words: [] },
      { paragraph: 6, quote: 'f', note: 'g', cut: '', words: [] },
    ],
  });
  assert.equal(read.readsAs, 'An essay on procrastination.');
  assert.equal(read.notes.length, 3, 'three at most, the one with no words dropped');
  assert.deepEqual(read.notes[0].words, ['refuge', 'lifeline'], 'a word or a short phrase, never a sentence');
  assert.equal(read.notes[1].cut, 'c');
  assert.throws(() => checkReadAlong({ reads_as: 'x', notes: [{ paragraph: '2' }] }), ShapeError);
  const task = readAlongTask([2, 5], 'An essay.', ['"x": y']);
  assert.ok(task.includes('these paragraphs are new or changed: 2, 5') && task.includes("Notes the writer dismissed (don't raise them again)"));
});

test('an answer: a reply, what it points at, and a cut, move or words only when complete', () => {
  const answer = checkAnswer({ reply: ' It lands later. ', show: ['now takes a weekend', ''], cut: '', move: 'a', after: 'b', replace: 'panacea', words: ['refuge'] });
  assert.equal(answer.reply, 'It lands later.');
  assert.deepEqual(answer.show, ['now takes a weekend']);
  assert.equal(answer.move, 'a');
  assert.throws(() => checkAnswer({ reply: 'x' }), ShapeError);
  const task = askTask('Why flat?', 'the hope', 'So when AI showed up…', [{ who: 'writer', text: 'Earlier question' }, { who: 'editor', text: 'Earlier answer' }], 'An essay.', 'I drifted.');
  assert.ok(task.includes('The writer asks: Why flat?') && task.includes('Writer: Earlier question') && task.includes('You: Earlier answer') && task.includes('Your note on it, which started this: I drifted.'));
  assert.ok(task.includes('Never write new sentences for the piece.'));
});

test('a reply shows as it streams: the reply field read out of JSON still being written', () => {
  assert.equal(partialField('{"re', 'reply'), '');
  assert.equal(partialField('{"reply":"It lands la', 'reply'), 'It lands la');
  assert.equal(partialField('{"reply":"Say \\"no\\" and\\nthen', 'reply'), 'Say "no" and\nthen');
  assert.equal(partialField('{"reply":"caf\\u00e9","show":[]}', 'reply'), 'café');
  assert.equal(partialField('{"reply":"done","show":["x"]}', 'reply'), 'done');
});

test('a streamed answer is put back together from its events, with each piece heard as it comes', async () => {
  const events = [
    { type: 'message_start' },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"reply":"It ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lands."}' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ];
  const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  // Cut mid-event, as a network does.
  const bytes = new TextEncoder().encode(sse);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(bytes.slice(0, 50));
      c.enqueue(bytes.slice(50));
      c.close();
    },
  });
  const heard: string[] = [];
  const answer = await readStream(new Response(stream), (s) => heard.push(s));
  assert.deepEqual(answerOf(answer), { reply: 'It lands.' });
  assert.deepEqual(heard, ['{"reply":"It ', '{"reply":"It lands."}']);
});

test('reading along uses the fast model, without the fallback a fast model lacks; asking streams on the deep one', async () => {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const fake = (async (_: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    headers.push(init.headers as Record<string, string>);
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const model = directModel('k', { fetch: fake });
  await model.ask({ system: [], task: '', schema: {}, effort: 'low', model: FAST_MODEL });
  assert.equal(bodies[0].model, 'claude-haiku-5-5');
  assert.equal(bodies[0].fallbacks, undefined);
  assert.equal(headers[0]['anthropic-beta'], undefined);
  await model.ask({ system: [], task: '', schema: {}, effort: 'medium' });
  assert.equal(bodies[1].model, 'claude-opus-5-5');
  assert.equal(bodies[1].fallbacks, 'default');
  assert.equal(bodies[1].stream, undefined);
});

test('a note is found again as the text changes, and fades when its words are gone', () => {
  const text: ReaderText = { paragraphs: [para('One two three.'), para(`The act of building${O} is a protective panacea.`)], comments: [], selection: null };
  const print = fingerprint(text.paragraphs[1].text);
  assert.deepEqual(locateNote(text, 'protective panacea', print), { index: 1, from: text.paragraphs[1].text.indexOf('protective'), to: text.paragraphs[1].text.length - 1 });
  // A paragraph added before it: still found.
  const moved: ReaderText = { ...text, paragraphs: [para('A new opening.'), ...text.paragraphs] };
  assert.equal(locateNote(moved, 'protective panacea', print)?.index, 2);
  // The words rewritten: gone.
  const rewritten: ReaderText = { ...text, paragraphs: [text.paragraphs[0], para('The act of building is a refuge.')] };
  assert.equal(locateNote(rewritten, 'protective panacea', print), null);
  // A note on a whole paragraph follows the paragraph, as long as it is the same.
  assert.deepEqual(locateNote(moved, '', print), { index: 2, from: 0, to: text.paragraphs[1].text.length });
  assert.equal(locateNote(rewritten, '', print), null);
});

test('a cut takes one space with it, so no double space is left', () => {
  const raw = 'Keep this. Cut this. And this.';
  const at = raw.indexOf('Cut this.');
  assert.deepEqual(cutRange(raw, at, at + 'Cut this.'.length), [at, at + 'Cut this.'.length + 1]);
  const end = 'Keep this, not that.';
  const tail = end.indexOf(' not that');
  assert.deepEqual(cutRange(end, tail + 1, end.length - 1), [tail, end.length - 1]);
});
