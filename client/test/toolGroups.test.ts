// A call to a tool group ("comments" with an action) runs as the single tool it stands for (src/assistant/toolGroups.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { converse, type Message } from '../src/assistant/conversation.ts';
import { expandTool } from '../src/assistant/toolGroups.ts';

test('a group call becomes the single tool, with the action taken out of the arguments', () => {
  assert.deepEqual(expandTool('comments', '{"action":"reply","id":"c1","text":"Thanks"}'), { name: 'reply_comment', arguments: '{"id":"c1","text":"Thanks"}' });
  assert.deepEqual(expandTool('history', '{"action":"undo"}'), { name: 'undo', arguments: '{}' });
  assert.deepEqual(expandTool('pdf_edit', '{"action":"page","page":2,"op":"delete"}'), { name: 'pdf_page', arguments: '{"page":2,"op":"delete"}' });
  assert.deepEqual(expandTool('files', '{"action":"move","files":["a"],"to":null}'), { name: 'move_files', arguments: '{"files":["a"],"to":null}' });
});

test('tools that are not groups pass through untouched', () => {
  const json = '{"paragraph":1,"bold":true}';
  assert.deepEqual(expandTool('format_text', json), { name: 'format_text', arguments: json });
  assert.deepEqual(expandTool('read_document', ''), { name: 'read_document', arguments: '' });
  assert.deepEqual(expandTool('insert_break', '{"after":2,"type":"page"}'), { name: 'insert_break', arguments: '{"after":2,"type":"page"}' });
});

test('a rule is a break to the model and its own command to the page', () => {
  assert.deepEqual(expandTool('insert_break', '{"after":2,"type":"rule"}'), { name: 'insert_horizontal_rule', arguments: '{"after":2}' });
});

test('a missing, unknown or inherited action is an error that names the choices', () => {
  for (const args of ['{}', '{"action":"explode"}', '{"action":"constructor"}', '{"action":3}']) {
    const r = expandTool('comments', args);
    assert.ok('error' in r && r.error.includes('list, add, edit, reply, resolve, delete'), args);
  }
  assert.ok('error' in expandTool('comments', 'nope'));
  assert.ok('error' in expandTool('comments', '[1]'));
  assert.deepEqual(expandTool('constructor', '{}'), { name: 'constructor', arguments: '{}' });
});

test('the conversation runs the single tool, tells progress its name, and answers a bad call with the error', async () => {
  const ran: string[] = [];
  const noted: string[] = [];
  let step = 0;
  const outcome = await converse(
    {
      ask: async () =>
        step++ === 0
          ? { message: { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'comments', arguments: '{"action":"delete","id":"c1"}' }, { id: 'b', name: 'comments', arguments: '{"action":"zap"}' }] }, creditsLeft: 50 }
          : { message: { role: 'assistant', content: 'Done.' }, creditsLeft: 50 },
      tool: async (name, args) => (ran.push(`${name} ${args}`), 'ok'),
    },
    [],
    'delete the comment',
    new AbortController().signal,
    { tool: (name) => noted.push(name) },
  );
  assert.deepEqual(ran, ['delete_comment {"id":"c1"}']);
  assert.deepEqual(noted, ['delete_comment']);
  const results = outcome.messages.filter((m: Message) => m.role === 'tool').map((m) => m.content);
  assert.equal(results[0], 'ok');
  assert.match(results[1], /^Error: `action` must be one of/);
  assert.equal(outcome.answer, 'Done.');
});
