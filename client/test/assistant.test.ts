// Clip's conversation loop and server calls, with the model and the document faked.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { askServer, fetchStatus } from '../src/assistant/api.ts';
import { AssistantError, MAX_HISTORY_CHARS, MAX_STEPS, converse, trimHistory, type Deps, type Message, type Reply } from '../src/assistant/conversation.ts';

const reply = (content: string, calls: { name: string; arguments?: string }[] = [], creditsLeft = 90): Reply => ({
  message: { role: 'assistant', content, ...(calls.length && { tool_calls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, arguments: c.arguments ?? '{}' })) }) },
  creditsLeft,
});

/** A fake model that gives these replies in turn, and a document that answers each tool with `tool`. */
function fake(replies: Reply[], tool: Deps['tool'] = async () => 'ok') {
  const seen: Message[][] = [];
  let next = 0;
  const deps: Deps = {
    async ask(messages) {
      seen.push(structuredClone(messages));
      return replies[Math.min(next++, replies.length - 1)]!;
    },
    tool,
  };
  return { deps, seen };
}

const signal = () => new AbortController().signal;

// --- the loop ---------------------------------------------------------------------------------

test('a plain answer is one turn and is added to the history', async () => {
  const { deps, seen } = fake([reply('Hello!')]);
  const out = await converse(deps, [], 'hi', signal());
  assert.equal(out.answer, 'Hello!');
  assert.equal(out.stopped, false);
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }]);
  assert.equal(seen.length, 1);
});

test('tool calls run on the document and their results go back to the model', async () => {
  const ran: string[] = [];
  const { deps, seen } = fake([reply('', [{ name: 'read_document' }, { name: 'find_text', arguments: '{"text":"x"}' }]), reply('Done.')], async (name, args) => {
    ran.push(`${name} ${args}`);
    return `result of ${name}`;
  });
  const tools: string[] = [];
  const out = await converse(deps, [], 'fix it', signal(), { tool: (n) => tools.push(n) });
  assert.deepEqual(ran, ['read_document {}', 'find_text {"text":"x"}']);
  assert.deepEqual(tools, ['read_document', 'find_text'], 'progress is reported as each tool starts');
  assert.equal(out.answer, 'Done.');
  // The second request carries the assistant's tool calls and both results, in order.
  const second = seen[1]!;
  assert.deepEqual(second.map((m) => m.role), ['user', 'assistant', 'tool', 'tool']);
  assert.deepEqual(second[2], { role: 'tool', tool_call_id: 'c0', content: 'result of read_document' });
  assert.deepEqual(second[3], { role: 'tool', tool_call_id: 'c1', content: 'result of find_text' });
});

test('credits are reported after every turn', async () => {
  const { deps } = fake([reply('', [{ name: 'get_selection' }], 80), reply('ok', [], 78)]);
  const seen: number[] = [];
  await converse(deps, [], 'x', signal(), { creditsLeft: (p) => seen.push(p) });
  assert.deepEqual(seen, [80, 78]);
});

test('a model that never stops asking for tools is cut off, and the history still ends in a way the server accepts', async () => {
  const { deps, seen } = fake([reply('still working', [{ name: 'read_document' }])]);
  const out = await converse(deps, [], 'x', signal());
  assert.equal(seen.length, MAX_STEPS);
  assert.equal(out.stopped, true);
  assert.equal(out.messages.at(-1)!.role, 'assistant');
  // Sent back next time, the conversation is valid: the last message before the new one is the assistant's.
  const next = fake([reply('ok')]);
  await converse(next.deps, out.messages, 'go on', signal());
  assert.equal(next.seen[0]!.at(-1)!.role, 'user');
});

test('an earlier conversation is sent along with a new request', async () => {
  const history: Message[] = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }];
  const { deps, seen } = fake([reply('three')]);
  const out = await converse(deps, history, 'four', signal());
  assert.deepEqual(seen[0]!.map((m) => m.content), ['one', 'two', 'four']);
  assert.equal(history.length, 2, 'the caller’s history is not changed');
  assert.equal(out.messages.length, 4);
});

test('a huge tool result is cut before it goes back to the model', async () => {
  const { deps, seen } = fake([reply('', [{ name: 'read_document' }]), reply('ok')], async () => 'x'.repeat(50_000));
  await converse(deps, [], 'x', signal());
  const result = seen[1]!.find((m) => m.role === 'tool')!;
  assert.ok(result.content.length < 10_000);
  assert.match(result.content, /cut short\)$/);
});

test('stopping between tools stops the run', async () => {
  const controller = new AbortController();
  const ran: string[] = [];
  const { deps } = fake([reply('', [{ name: 'a' }, { name: 'b' }])], async (name) => {
    ran.push(name);
    controller.abort();
    return 'ok';
  });
  await assert.rejects(converse(deps, [], 'x', controller.signal), { name: 'AbortError' });
  assert.deepEqual(ran, ['a'], 'the second tool never ran');
});

test('failures from the server pass through untouched', async () => {
  const deps: Deps = {
    async ask() {
      throw new AssistantError('credits');
    },
    tool: async () => 'ok',
  };
  await assert.rejects(converse(deps, [], 'x', signal()), (e: unknown) => e instanceof AssistantError && e.kind === 'credits');
});

// --- trimming ---------------------------------------------------------------------------------

test('a short conversation is left alone', () => {
  const messages: Message[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
  assert.deepEqual(trimHistory(messages), messages);
});

test('a long one drops its oldest turns, and starts on a message from the person', () => {
  const big = 'x'.repeat(MAX_HISTORY_CHARS / 3);
  const messages: Message[] = [
    { role: 'user', content: big },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'read_document', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'a', content: big },
    { role: 'assistant', content: big },
    { role: 'user', content: big },
    { role: 'assistant', content: 'short' },
    { role: 'user', content: 'latest' },
  ];
  const trimmed = trimHistory(messages);
  assert.equal(trimmed[0]!.role, 'user');
  assert.equal(trimmed.at(-1)!.content, 'latest');
  assert.ok(trimmed.reduce((n, m) => n + m.content.length, 0) <= MAX_HISTORY_CHARS);
  // No tool result is left without the call that asked for it.
  for (const [i, m] of trimmed.entries()) if (m.role === 'tool') assert.equal(trimmed[i - 1]!.role === 'assistant' || trimmed[i - 1]!.role === 'tool', true);
});

test('the newest message is always kept, even if it alone is too long', () => {
  const trimmed = trimHistory([{ role: 'user', content: 'old' }, { role: 'assistant', content: 'older' }, { role: 'user', content: 'x'.repeat(MAX_HISTORY_CHARS * 2) }]);
  assert.equal(trimmed.length, 1);
});

// --- talking to the server --------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const serve = (status: number, body: unknown = {}) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
};

test('askServer maps the server’s refusals to what the person can do about them', async () => {
  const kind = async () => {
    try {
      await askServer([{ role: 'user', content: 'x' }], signal());
    } catch (e) {
      return (e as AssistantError).kind;
    }
  };
  serve(401);
  assert.equal(await kind(), 'signin');
  serve(402, { code: 'subscription' });
  assert.equal(await kind(), 'subscription');
  serve(402, { code: 'credits' });
  assert.equal(await kind(), 'credits');
  serve(503);
  assert.equal(await kind(), 'unavailable');
  serve(500);
  assert.equal(await kind(), 'failed');
  globalThis.fetch = (async () => {
    throw new TypeError('offline');
  }) as typeof fetch;
  assert.equal(await kind(), 'failed');
});

test('askServer posts the conversation as JSON and returns the reply', async () => {
  let sent: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(JSON.stringify(reply('hi')));
  }) as typeof fetch;
  const messages: Message[] = [{ role: 'user', content: 'x' }];
  assert.equal((await askServer(messages, signal())).message.content, 'hi');
  assert.equal(sent!.url, '/api/assistant');
  assert.equal(sent!.init.method, 'POST');
  assert.deepEqual(JSON.parse(sent!.init.body as string), { messages });
});

test('an aborted request stays an abort, not a failure', async () => {
  globalThis.fetch = (async () => {
    throw new DOMException('Aborted', 'AbortError');
  }) as typeof fetch;
  await assert.rejects(askServer([{ role: 'user', content: 'x' }], signal()), { name: 'AbortError' });
});

test('the status is null when signed out or unreachable', async () => {
  serve(401);
  assert.equal(await fetchStatus(), null);
  serve(200, { available: true, subscribed: true, creditsLeft: 64 });
  assert.deepEqual(await fetchStatus(), { available: true, subscribed: true, creditsLeft: 64 });
  globalThis.fetch = (async () => {
    throw new TypeError('offline');
  }) as typeof fetch;
  assert.equal(await fetchStatus(), null);
});
