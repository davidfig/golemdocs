// Afterward (docs/afterward.md): readers who review a piece through the comments. The Messages API is answered here by
// `page.route`, so the app's own request code runs and no key or network is needed; each answer is picked by the schema
// the request asks for.

import type { Page, Route } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { commentsTitle } from './helpers';
import { test as guestTest } from '../files/fixtures';
import { importFile, text as textFile } from '../files/helpers';

const API = 'https://api.anthropic.com/v1/messages';

const OPENING = 'It was a slow morning and nothing happened for a long while.';
const MIDDLE = 'Then the river rose, and the whole town came out to watch it.';

type Answer = Record<string, unknown> | { status: number; error: string } | ((task: string) => Record<string, unknown>);

/** Answers the API: by the schema asked for (review, replies, reread, studies); records each request's body. */
async function fakeApi(page: Page, answers: { review?: Answer; replies?: Answer[]; reread?: Answer; studies?: Answer; outline?: Answer; queries?: Answer; quotes?: Answer; journal?: Answer; book?: Answer }): Promise<{ bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const replies = [...(answers.replies ?? [])];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  await page.route(API, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postDataJSON() as { output_config: { format: { schema: { properties: Record<string, unknown> } } }; messages: { content: string }[] };
    bodies.push(body);
    const props = Object.keys(body.output_config.format.schema.properties);
    const given = props.includes('overview')
      ? answers.book
      : props.includes('moments')
      ? answers.review
      : props.includes('threads')
        ? answers.reread
        : props.includes('studies')
          ? answers.studies
          : props.includes('observations')
            ? answers.outline
            : props.includes('queries')
              ? answers.queries
              : props.includes('quotes')
                ? answers.quotes
                : props.includes('entry')
                  ? answers.journal
                  : props.includes('overview')
                    ? answers.book
                    : replies.shift();
    const answer = typeof given === 'function' ? given(body.messages[0].content) : given;
    if (!answer) return route.fulfill({ status: 500, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: { message: 'no answer set up' } }) });
    if ('status' in answer && typeof answer.status === 'number') return route.fulfill({ status: answer.status, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: { message: answer.error } }) });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] }) });
  });
  return { bodies };
}

const REVIEW = {
  attention: [
    { paragraph: 1, level: 'drifts', note: 'I almost left.' },
    { paragraph: 2, level: 'leans_in', note: 'Now something is happening.' },
  ],
  moments: [
    { paragraph: 1, quote: 'nothing happened for a long while', kind: 'attention_change', question: 'What is this opening doing for the piece?', reaction: 'I nearly stopped here.' },
    { paragraph: 2, quote: 'the river rose', kind: 'strength', question: 'Why does the river arrive here?', reaction: 'This is where it starts.' },
  ],
};

async function writePiece(app: App): Promise<void> {
  await app.blank();
  await app.type(OPENING);
  await app.press('Enter');
  await app.type(MIDDLE);
}

/** Tools › Afterward › Read It Afterward…, saying who the piece is for, with a key typed in. */
async function readIt(app: App, page: Page): Promise<void> {
  await app.menu('Tools', 'Afterward', 'Read It Afterward');
  const dialog = page.getByRole('dialog', { name: 'Read It Afterward' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Who it's for (optional)").fill('people who grew up by rivers');
  await dialog.getByLabel('Anthropic API key').fill('sk-ant-test');
  await dialog.getByRole('button', { name: 'Read', exact: true }).click();
}

const card = (page: Page, text: string) => page.locator('.wm-comments .wm-comment').filter({ hasText: text });

test.describe('Afterward', () => {
  test('a read puts each moment in a thread that asks first, keeps the reactions back, and leaves the text alone', async ({ app, page }) => {
    const api = await fakeApi(page, { review: REVIEW });
    await writePiece(app);
    await readIt(app, page);
    await expect(commentsTitle(page)).toHaveText('Comments (2)');
    const first = card(page, 'What is this opening doing for the piece?');
    await expect(first.locator('strong').first()).toHaveText('Afterward');
    // The first question opens by itself, so the writer can answer at once.
    await expect(first).toHaveClass(/wm-comment-active/);
    await expect(first.getByPlaceholder('Reply…')).toBeVisible();
    await expect(first.locator('.wm-comment-agent svg').first()).toBeVisible();
    // The reactions are kept back until the writer answers.
    await expect(page.locator('.wm-comments')).not.toContainText('I nearly stopped here.');
    expect(await app.text()).toBe(`${OPENING}\n${MIDDLE}`);
    // The key went to Anthropic, the piece was numbered, and who it is for was said.
    const body = api.bodies[0] as { system: { text: string }[]; messages: { content: string }[]; model: string };
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.system[0].text).toContain('The writer says the piece is for: people who grew up by rivers');
    expect(body.system[1].text).toContain(`[1] ${OPENING}`);
    // Its attention, beside the text: one dot a paragraph, and a key to the colours.
    await expect(page.locator('.wm-comments-mark')).toHaveCount(2);
    await expect(page.locator('.wm-comments-mark .wm-comments-dot')).toHaveCount(2);
    await expect(page.locator('.wm-comments-mark .wm-dot-drifts')).toHaveAttribute('title', 'drifts. I almost left.');
    await expect(page.locator('.wm-comments-key')).toContainText('leans in');
  });

  test('one undo takes a whole read away', async ({ app, page }) => {
    await fakeApi(page, { review: REVIEW });
    await writePiece(app);
    await readIt(app, page);
    await expect(commentsTitle(page)).toHaveText('Comments (2)');
    await app.focus();
    await app.press(`ControlOrMeta+z`);
    await expect(page.locator('.wm-comments .wm-comment')).toHaveCount(0);
    expect(await app.text()).toBe(`${OPENING}\n${MIDDLE}`);
  });

  test('answering the question brings out how Afterward read it; a later reply is answered too', async ({ app, page }) => {
    const api = await fakeApi(page, {
      review: REVIEW,
      replies: [{ reply: 'Knowing that, I stayed, but only just.' }, { reply: 'I would still have left before the river.' }],
    });
    await writePiece(app);
    await readIt(app, page);
    const thread = card(page, 'What is this opening doing for the piece?');
    await thread.click();
    const reply = thread.getByPlaceholder('Reply…');
    await reply.fill('It sets up how dull the town is before the flood.');
    await reply.press('Enter');
    await expect(thread).toContainText('Knowing that, I stayed, but only just.');
    // One voice: every comment of Afterward's is signed Afterward.
    await expect(thread.locator('strong').filter({ hasText: 'Afterward' })).toHaveCount(2);
    // The held-back reaction went to the model with the writer's answer.
    const answer = api.bodies[1] as { messages: { content: string }[] };
    expect(answer.messages[0].content).toContain('I nearly stopped here.');
    expect(answer.messages[0].content).toContain('It sets up how dull the town is before the flood.');
    await thread.getByPlaceholder('Reply…').fill('What if it were shorter?');
    await thread.getByPlaceholder('Reply…').press('Enter');
    await expect(thread).toContainText('I would still have left before the river.');
    const later = api.bodies[2] as { messages: { content: string }[] };
    expect(later.messages[0].content).toContain('The writer has just added the last comment');
    expect(later.messages[0].content).toContain('What if it were shorter?');
  });

  test('@Afterward in any comment brings Afterward into the thread', async ({ app, page }) => {
    await fakeApi(page, { replies: [{ reply: 'That sounds like you.' }] });
    await writePiece(app);
    await page.evaluate(() => localStorage.setItem('golem.afterward.key', 'sk-ant-test'));
    await app.press('Home');
    await app.press('Shift+End');
    await app.menu('Insert', 'Comment');
    const draft = page.locator('.wm-comment-draft textarea');
    await draft.fill('@Afterward does this sound like me?');
    await draft.press('Enter');
    await expect(card(page, 'does this sound like me?')).toContainText('That sounds like you.');
  });

  test('a failure stays under the thread with Try Again; It’s on Purpose resolves the thread', async ({ app, page }) => {
    await fakeApi(page, { review: REVIEW, replies: [{ status: 401, error: 'invalid x-api-key' }, { reply: 'Fair enough.' }] });
    await writePiece(app);
    await readIt(app, page);
    const thread = card(page, 'What is this opening doing for the piece?');
    await thread.click();
    await thread.getByPlaceholder('Reply…').fill('On purpose: the town is dull.');
    await thread.getByPlaceholder('Reply…').press('Enter');
    await expect(thread.locator('.wm-comment-note-error')).toContainText("didn't accept the API key");
    await thread.getByRole('button', { name: 'Try Again' }).click();
    await expect(thread).toContainText('Fair enough.');
    await thread.getByRole('button', { name: 'It\'s on Purpose' }).click();
    // Resolved; it stays open while it is the thread in view, as any resolved thread does.
    await expect(thread).toHaveClass(/wm-comment-resolved/);
    await expect(thread.getByRole('button', { name: 'It\'s on Purpose' })).toHaveCount(0);
    // Two questions, the answer and Afterward's reply.
    await expect(commentsTitle(page)).toHaveText('Comments (4)');
  });

  test('without a key the dialog asks for one, and Read Again with no review starts one', async ({ app, page }) => {
    await writePiece(app);
    await app.menu('Tools', 'Afterward', 'Read Again');
    const dialog = page.getByRole('dialog', { name: 'Read It Afterward' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Enter an Anthropic API key to read with.');
  });

  test('after a revision, Read Again sends the changed passage and Afterward says what changed for it', async ({ app, page }) => {
    const api = await fakeApi(page, {
      review: REVIEW,
      reread: (task) => {
        const thread = /Thread (\d+)/.exec(task)?.[1] ?? '';
        return { threads: [{ thread, reply: 'I didn’t drift this time.' }], attention: REVIEW.attention };
      },
    });
    await writePiece(app);
    await readIt(app, page);
    await expect(commentsTitle(page)).toHaveText('Comments (2)');
    // Revise the second paragraph: its end gets new words.
    await app.focus();
    await app.press(`ControlOrMeta+End`);
    await app.type(' Nobody had seen it so high.');
    await app.menu('Tools', 'Afterward', 'Read Again');
    const thread = card(page, 'Why does the river arrive here?');
    await expect(thread).toContainText('I didn’t drift this time.');
    const reread = api.bodies[1] as { messages: { content: string }[] };
    expect(reread.messages[0].content).toContain('Nobody had seen it so high.');
    // Only the thread whose passage changed was sent.
    expect(reread.messages[0].content).not.toContain('What is this opening doing');
  });

  test('Make Studies posts exercises as threads on the passages', async ({ app, page }) => {
    await fakeApi(page, {
      review: REVIEW,
      studies: { studies: [{ paragraph: 1, quote: 'It was a slow morning', pattern: 'the point arrives late', exercise: 'Open with the river in one sentence.' }] },
    });
    await writePiece(app);
    await readIt(app, page);
    await expect(commentsTitle(page)).toHaveText('Comments (2)');
    await app.menu('Tools', 'Afterward', 'Make Studies');
    await expect(commentsTitle(page)).toHaveText('Comments (3)');
    await expect(card(page, 'Study: the point arrives late')).toContainText('Open with the river in one sentence.');
  });

  test('typing @ in a reply suggests Afterward; Enter puts it in', { tag: '@heavy' }, async ({ app, page }) => {
    await fakeApi(page, { review: REVIEW });
    await writePiece(app);
    await readIt(app, page);
    const thread = card(page, 'What is this opening doing for the piece?');
    await thread.click();
    const box = thread.getByPlaceholder('Reply…');
    await box.pressSequentially('Thanks @Af');
    const list = thread.getByRole('listbox', { name: 'Suggestions' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveText(['Afterward']);
    await box.press('Enter');
    await expect(box).toHaveValue('Thanks @Afterward ');
    await expect(list).toBeHidden();
  });

  test('Reverse Outline shows what each paragraph does, goes to a paragraph, and isn’t asked for again while the piece is the same', async ({ app, page }) => {
    const api = await fakeApi(page, { outline: { paragraphs: [{ paragraph: 1, does: 'sets a dull scene' }, { paragraph: 2, does: 'the flood: the real start' }], point: 2, observations: ['1 delays what 2 is about'] } });
    await writePiece(app);
    await app.menu('Tools', 'Afterward', 'Reverse Outline');
    // No key on this device yet: it is asked for first.
    const ask = page.getByRole('dialog', { name: 'Anthropic API Key' });
    await ask.getByLabel('Anthropic API key').fill('sk-ant-test');
    await ask.getByRole('button', { name: 'Use Key' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reverse Outline' });
    await expect(dialog.getByRole('button', { name: /¶1\s*sets a dull scene/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /¶2/ })).toContainText('main point');
    await expect(dialog).toContainText('1 delays what 2 is about');
    await dialog.getByRole('button', { name: /¶2/ }).click();
    await expect(dialog).toHaveCount(0);
    // The caret is at the start of paragraph 2: what is typed goes there.
    await app.type('X');
    expect(await app.text()).toBe(`${OPENING}\nX${MIDDLE}`);
    await app.press('ControlOrMeta+z');
    await expect.poll(() => app.text()).toBe(`${OPENING}\n${MIDDLE}`);
    await app.menu('Tools', 'Afterward', 'Reverse Outline');
    await expect(page.getByRole('dialog', { name: 'Reverse Outline' })).toBeVisible();
    expect(api.bodies.length).toBe(1);
  });
  test('comment cards scroll with their text: threads scrolled past go off the top instead of piling up there', async ({ app, page }) => {
    const lines = Array.from({ length: 40 }, (_, k) => `Line ${k + 1} of the long piece, with enough words to fill a line or two of the page.`);
    const moment = (n: number) => ({ paragraph: n, quote: `Line ${n} of the long piece`, kind: 'structure', question: `Question about line ${n}?`, reaction: 'r' });
    await fakeApi(page, { review: { attention: [], moments: [moment(1), moment(2), moment(3), moment(38)] } });
    await app.blank();
    for (const [k, line] of lines.entries()) {
      await app.type(line);
      if (k < lines.length - 1) await app.press('Enter');
    }
    await readIt(app, page);
    await expect(commentsTitle(page)).toHaveText('Comments (4)');
    // At the end of the piece: the last thread beside its text, the first three gone off the top, not stacked under the bar.
    await app.focus();
    await app.press('ControlOrMeta+End');
    const last = card(page, 'Question about line 38?');
    await expect(last).toBeVisible();
    for (const n of [1, 2, 3]) await expect(card(page, `Question about line ${n}?`)).toBeHidden();
    const bar = await page.locator('.wm-comments-bar').boundingBox();
    const box = await last.boundingBox();
    expect(box!.y).toBeGreaterThan(bar!.y + bar!.height);
    // Back at the top, the first three are beside their lines again.
    await app.press('ControlOrMeta+Home');
    for (const n of [1, 2, 3]) await expect(card(page, `Question about line ${n}?`)).toBeVisible();
  });
});

guestTest.describe('Afterward: quotes from your notes', () => {
  guestTest('only words really in a source become quotes, in the source’s own words, on the selected passage', async ({ app, page }) => {
    const api = await fakeApi(page, {
      queries: { queries: ['flood river'] },
      quotes: {
        quotes: [
          { source: 1, quote: 'The town had "no plan at all" for the evacuation.', why: 'Backs the claim that nobody was ready.' },
          { source: 1, quote: 'Every house on the river was lost.', why: 'Invented: must never appear.' },
        ],
      },
    });
    await app.goto('?doc=welcome');
    await importFile(app, textFile('Flood notes.md', '# Flood notes\n\nThe river rose 3 metres in 48 hours.\n\nThe town had “no plan at all” for the evacuation.\n'));
    await expect(page.locator('.wm-sync')).toHaveAttribute('data-local', 'saved', { timeout: 15_000 });
    await app.menu('File', 'New');
    await app.focus();
    await app.type('Nobody in town was ready when the flood came.');
    await expect(page.locator('.wm-sync')).toHaveAttribute('data-local', 'saved', { timeout: 15_000 });
    await page.evaluate(() => localStorage.setItem('golem.afterward.key', 'sk-ant-test'));
    await app.menu('Tools', 'Afterward', 'Find Quotes in My Notes');
    const thread = page.locator('.wm-comments .wm-comment').filter({ hasText: 'From your notes' });
    await expect(thread).toContainText('1 passage that bears on this (Flood notes.md)');
    await expect(thread).toContainText('“The town had “no plan at all” for the evacuation.”');
    await expect(thread).toContainText('— Flood notes.md');
    await expect(page.locator('.wm-comments')).not.toContainText('Every house on the river was lost.');
    // The model was given the note's own text to quote from.
    const quotes = api.bodies[1] as { messages: { content: string }[] };
    expect(quotes.messages[0].content).toContain('Source 1: Flood notes.md');
    expect(quotes.messages[0].content).toContain('The river rose 3 metres in 48 hours.');
    expect(await app.text()).toBe('Nobody in town was ready when the flood came.');
  });
});

guestTest.describe('Afterward: a long piece', () => {
  guestTest('reads the chapter the cursor is in, remembering the chapters before and knowing nothing after', async ({ app, page }) => {
    const words = (c: number, p: number) => `Chapter ${c} paragraph ${p}. ${'More of the story goes here. '.repeat(40).trim()}`;
    const markdown = ['# The Book', ...[1, 2, 3].flatMap((c) => [`## Chapter ${c}`, ...Array.from({ length: 10 }, (_, p) => words(c, p + 1))])].join('\n\n') + '\n';
    const api = await fakeApi(page, {
      review: { attention: [{ paragraph: 1, level: 'leans_in', note: 'Back in.' }], moments: [{ paragraph: 1, quote: 'Chapter 2 paragraph 1', kind: 'structure', question: 'Why open the chapter this way?', reaction: 'r' }] },
      replies: [{ reply: 'I remembered the first two chapters here.' }],
    });
    await app.goto('?doc=welcome');
    await importFile(app, textFile('The Book.md', markdown));
    await expect(page.locator('.wm-sync')).toHaveAttribute('data-local', 'saved', { timeout: 15_000 });
    await app.focus();
    // The cursor in the middle chapter.
    await app.press('ControlOrMeta+Home');
    await app.menu('Edit', 'Find');
    const find = page.getByRole('dialog', { name: 'Find and Replace' });
    await find.getByRole('textbox', { name: 'Find what' }).fill('Chapter 2 paragraph 3');
    await expect.poll(() => app.selectedText()).toBe('Chapter 2 paragraph 3');
    await page.keyboard.press('Escape');
    await expect(find).toBeHidden();
    await page.evaluate(() => localStorage.setItem('golem.afterward.key', 'sk-ant-test'));
    await app.menu('Tools', 'Afterward', 'Read It Afterward');
    const dialog = page.getByRole('dialog', { name: 'Read It Afterward' });
    await expect(dialog).toContainText('It will read “Chapter 2”, the chapter your cursor is in');
    await dialog.getByRole('button', { name: 'Read', exact: true }).click();
    const thread = page.locator('.wm-comments .wm-comment').filter({ hasText: 'Why open the chapter this way?' });
    await expect(thread).toBeVisible();
    const body = api.bodies[0] as { system: { text: string }[] };
    // The rules, chapter 1 as what was read, then chapter 2 numbered; nothing of chapter 3.
    expect(body.system).toHaveLength(3);
    expect(body.system[1].text).toContain('What you have read so far');
    expect(body.system[1].text).toContain('Chapter 1 paragraph 10.');
    expect(body.system[2].text).toContain('The chapter you are reading now, "Chapter 2"');
    expect(body.system[2].text).toContain('[1] Chapter 2 paragraph 1.');
    expect(body.system.map((b) => b.text).join('')).not.toContain('Chapter 3 paragraph');
    // A reply in the thread is read in the same chapter.
    await thread.click();
    await thread.getByPlaceholder('Reply…').fill('It picks up where chapter one left off.');
    await thread.getByPlaceholder('Reply…').press('Enter');
    await expect(thread).toContainText('I remembered the first two chapters here.');
    const reply = api.bodies[1] as { system: { text: string }[] };
    expect(reply.system[2].text).toContain('The chapter you are reading now, "Chapter 2"');
  });

  guestTest('the whole book: a journal chapter by chapter, then comments on the book, and a second read remembers unchanged chapters', async ({ app, page }) => {
    const words = (c: number, p: number) => `Chapter ${c} paragraph ${p}. ${'More of the story goes here. '.repeat(40).trim()}`;
    const markdown = ['# The Book', ...[1, 2, 3].flatMap((c) => [`## Chapter ${c}`, ...Array.from({ length: 10 }, (_, p) => words(c, p + 1))])].join('\n\n') + '\n';
    const api = await fakeApi(page, {
      journal: (task) => {
        const n = /Chapter (\d+) of 3/.exec(task)?.[1] ?? '?';
        return { attention: n === '2' ? 'drifts' : 'holds', note: `Chapter ${n} note.`, entry: `Entry for chapter ${n}.`, marks: [{ about: 'the opening', quote: `Chapter ${n} paragraph 1.` }] };
      },
      book: {
        overview: 'It held me until the middle sagged.',
        moments: [{ chapter: 2, quote: 'Chapter 2 paragraph 1.', kind: 'sag', question: 'What should the reader be waiting for in this chapter?', reaction: 'I drifted here.' }],
      },
    });
    await app.goto('?doc=welcome');
    await importFile(app, textFile('The Book.md', markdown));
    await expect(page.locator('.wm-sync')).toHaveAttribute('data-local', 'saved', { timeout: 15_000 });
    await page.evaluate(() => localStorage.setItem('golem.afterward.key', 'sk-ant-test'));
    await app.menu('Tools', 'Afterward', 'Read the Whole Book');
    const confirm = page.getByRole('dialog', { name: 'Read the Whole Book' });
    await expect(confirm).toContainText('Afterward will read 3 chapters');
    await expect(confirm).toContainText('That is 4 requests, about $');
    await confirm.getByRole('button', { name: 'Read the Book' }).click();
    // The overview on the book's first words, and the moment in its chapter.
    await expect(page.locator('.wm-comments .wm-comment').filter({ hasText: 'The whole book, as I read it:' })).toContainText('It held me until the middle sagged.');
    await expect(page.locator('.wm-comments .wm-comment').filter({ hasText: 'What should the reader be waiting for in this chapter?' })).toHaveCount(1);
    await expect(page.locator('.wm-comments-dot-chapter')).toHaveCount(3);
    await expect(page.locator('.wm-comments-dot-chapter.wm-dot-drifts')).toHaveAttribute('title', 'Chapter 2: drifts. Chapter 2 note.');
    // Chapter 2 was read with chapter 1's journal entry, not chapter 1 itself.
    const second = api.bodies[1] as { messages: { content: string }[] };
    expect(second.messages[0].content).toContain('Entry for chapter 1.');
    expect(second.messages[0].content).toContain('Chapter 2 paragraph 10.');
    expect(second.messages[0].content).not.toContain('Chapter 1 paragraph 10.');
    expect(api.bodies).toHaveLength(4);
    // Read again with nothing changed: the chapters are remembered; only the look back is asked for.
    await app.menu('Tools', 'Afterward', 'Read the Whole Book');
    await expect(confirm).toContainText("3 chapters haven't changed since the last read and are remembered.");
    await expect(confirm).toContainText('That is 1 requests');
    await confirm.getByRole('button', { name: 'Read the Book' }).click();
    await expect.poll(() => api.bodies.length).toBe(5);
  });
});

