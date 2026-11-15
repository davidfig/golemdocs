// Afterward (docs/afterward.md), the editor in the margin. The Messages API is answered here by `page.route`, so the app's own
// request code runs (streaming included) and no key or network is needed; each answer is picked by the schema asked for.

import type { Page, Route } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { commentsTitle } from './helpers';
import { test as guestTest } from '../files/fixtures';
import { importFile, text as textFile } from '../files/helpers';

const API = 'https://api.anthropic.com/v1/messages';

const OPENING = 'I build things to stay out of dark places, because the act of building is a protective panacea.';
const MIDDLE = 'Then the river rose, and the whole town came out to watch it, and nobody went home for hours.';

type Answer = Record<string, unknown> | { status: number; error: string } | ((task: string) => Record<string, unknown>);
type Body = { model: string; stream?: boolean; system: { text: string }[]; messages: { content: string }[]; output_config: { format: { schema: { properties: Record<string, unknown> } } } };

/** Answers the API by the schema asked for; a streamed request gets its answer as server-sent events. Records each body. */
async function fakeApi(page: Page, answers: { read?: Answer[]; ask?: Answer[]; outline?: Answer; queries?: Answer; quotes?: Answer }): Promise<{ bodies: Body[] }> {
  const bodies: Body[] = [];
  const read = [...(answers.read ?? [])];
  const ask = [...(answers.ask ?? [])];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  await page.route(API, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postDataJSON() as Body;
    bodies.push(body);
    const props = Object.keys(body.output_config.format.schema.properties);
    const given = props.includes('reads_as') ? read.shift() : props.includes('reply') ? ask.shift() : props.includes('observations') ? answers.outline : props.includes('queries') ? answers.queries : props.includes('quotes') ? answers.quotes : undefined;
    const answer = typeof given === 'function' ? given(body.messages[0].content) : given;
    if (!answer) return route.fulfill({ status: 500, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: { message: 'no answer set up' } }) });
    if ('status' in answer && typeof answer.status === 'number') return route.fulfill({ status: answer.status, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: { message: answer.error } }) });
    const json = JSON.stringify(answer);
    if (body.stream) {
      // In three pieces, as the API streams it.
      const pieces = [json.slice(0, 14), json.slice(14, 30), json.slice(30)];
      const events = [
        { type: 'message_start' },
        ...pieces.map((text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } })),
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ];
      return route.fulfill({ status: 200, headers: cors, contentType: 'text/event-stream', body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') });
    }
    await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: json }] }) });
  });
  return { bodies };
}

const PANACEA = { reads_as: 'An essay on why building keeps you out of dark places.', notes: [{ paragraph: 1, quote: 'protective panacea', note: 'A panacea cures; it doesn’t protect. I read it twice.', cut: '', words: ['refuge', 'lifeline', 'shelter'] }] };

/** A key on this device, and reading along on (or off), before the app loads. */
async function readingAlong(page: Page, on = true): Promise<void> {
  await page.addInitScript((readAlong) => {
    localStorage.setItem('golem.afterward.key', 'sk-ant-test');
    if (readAlong) localStorage.setItem('golem.afterward.readAlong', 'on');
  }, on);
}

async function writePiece(app: App): Promise<void> {
  await app.blank();
  await app.type(OPENING);
  await app.press('Enter');
  await app.type(MIDDLE);
}

const note = (page: Page, text: string) => page.locator('.wm-comments .wm-editor-note').filter({ hasText: text });

test.describe('Afterward, the editor in the margin', () => {
  test('reading along: after a pause, the fast model reads what changed and leaves a quiet note beside its words', async ({ app, page }) => {
    await readingAlong(page);
    const api = await fakeApi(page, { read: [PANACEA] });
    await writePiece(app);
    const card = note(page, 'A panacea cures');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.wm-comments-subtitle')).toHaveText('Reads as: An essay on why building keeps you out of dark places.');
    // Only the editor's notes: the panel is titled for them, not "Comments (0)".
    await expect(commentsTitle(page)).toHaveText('Afterward');
    expect(api.bodies[0].model).toBe('claude-haiku-5-5');
    expect(api.bodies[0].messages[0].content).toContain('these paragraphs are new or changed: 1, 2');
    // The note's words are marked on the page (a dotted line, counted with the squiggles).
    await expect.poll(() => page.evaluate(() => (window as unknown as { selectionState: { squiggles: number } }).selectionState.squiggles)).toBeGreaterThan(0);
    // It doesn't read again until something changes.
    await page.waitForTimeout(4500);
    expect(api.bodies).toHaveLength(1);
    expect(await app.text()).toBe(`${OPENING}\n${MIDDLE}`);
  });

  test('a paragraph edited and read again keeps one note on the same words, not two', async ({ app, page }) => {
    await readingAlong(page);
    const api = await fakeApi(page, { read: [PANACEA, PANACEA] });
    await writePiece(app);
    await expect(note(page, 'A panacea cures')).toHaveCount(1, { timeout: 15_000 });
    // An edit in the same paragraph (its start), read again: the same note comes back.
    await app.focus();
    await app.press('ControlOrMeta+Home');
    await app.type('Honestly, ');
    await expect.poll(() => api.bodies.length, { timeout: 15_000 }).toBe(2);
    await page.waitForTimeout(800);
    await expect(note(page, 'A panacea cures')).toHaveCount(1);
  });

  test('a word offered by the editor is swapped in only when the writer picks it, as their own edit', async ({ app, page }) => {
    await readingAlong(page);
    await fakeApi(page, { read: [PANACEA] });
    await writePiece(app);
    const card = note(page, 'A panacea cures');
    await card.click();
    await expect(card.getByText('Instead of “protective panacea”:')).toBeVisible();
    await card.getByRole('button', { name: 'refuge' }).click();
    await expect.poll(() => app.text()).toBe(`${OPENING.replace('protective panacea', 'refuge')}\n${MIDDLE}`);
    await expect(card).toHaveCount(0);
    // Undo takes it back, like any edit.
    await app.focus();
    await app.press('ControlOrMeta+z');
    await expect.poll(() => app.text()).toBe(`${OPENING}\n${MIDDLE}`);
  });

  test('asking about a selection: the answer streams into the margin, points at the text, and a cut is made only on Cut', async ({ app, page }) => {
    await readingAlong(page, false);
    const api = await fakeApi(page, {
      ask: [{ reply: 'The second clause repeats the first; I would end at the river.', show: ['the whole town came out to watch it'], cut: ', and nobody went home for hours', move: '', after: '', replace: '', words: [] }],
    });
    await writePiece(app);
    await app.press('Home');
    await app.press('Shift+End');
    await app.menu('Tools', 'Afterward', 'Ask the Editor');
    const card = page.locator('.wm-comments .wm-editor-note.wm-comment-active');
    const box = card.getByPlaceholder('Ask about this…');
    await expect(box).toBeFocused();
    await box.fill('Does this sentence run long?');
    await box.press('Enter');
    await expect(card).toContainText('The second clause repeats the first; I would end at the river.');
    const body = api.bodies[0];
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toContain('The writer asks: Does this sentence run long?');
    await expect(card.getByRole('button', { name: /Show me “the whole town came out to watch it”/ })).toBeVisible();
    await expect(card).toContainText('Cut “, and nobody went home for hours”?');
    expect(await app.text()).toBe(`${OPENING}\n${MIDDLE}`);
    await card.getByRole('button', { name: 'Cut', exact: true }).click();
    await expect.poll(() => app.text()).toBe(`${OPENING}\nThen the river rose, and the whole town came out to watch it.`);
  });

  test('a note can be pinned as a comment; a later change is read again', async ({ app, page }) => {
    await readingAlong(page);
    const api = await fakeApi(page, { read: [PANACEA, { reads_as: 'Still an essay.', notes: [] }] });
    await writePiece(app);
    const card = note(page, 'A panacea cures');
    await card.click();
    await card.getByRole('button', { name: 'Pin as Comment' }).click();
    await expect(commentsTitle(page)).toHaveText('Comments (1)');
    await expect(page.locator('.wm-comments .wm-comment:not(.wm-editor-note) strong').first()).toHaveText('Afterward');
    await expect(card).toHaveCount(0);
    await app.focus();
    await app.press('ControlOrMeta+End');
    await app.type(' They stayed until dark.');
    await expect.poll(() => api.bodies.length, { timeout: 15_000 }).toBe(2);
    expect(api.bodies[1].messages[0].content).toContain('these paragraphs are new or changed: 2');
  });

  test('read along off: nothing is read; turning it on from the menu reads the piece', async ({ app, page }) => {
    await readingAlong(page, false);
    const api = await fakeApi(page, { read: [PANACEA] });
    await writePiece(app);
    await page.waitForTimeout(4500);
    expect(api.bodies).toHaveLength(0);
    await app.menu('Tools', 'Afterward', 'Read Along');
    await expect(note(page, 'A panacea cures')).toBeVisible({ timeout: 15_000 });
  });

  test('with no key, asking asks for one first', async ({ app, page }) => {
    await writePiece(app);
    await app.press('Home');
    await app.press('Shift+End');
    await app.menu('Tools', 'Afterward', 'Ask the Editor');
    const ask = page.getByRole('dialog', { name: 'Anthropic API Key' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Use Key' }).click();
    await expect(ask.getByRole('alert')).toHaveText('Enter an Anthropic API key to read with.');
  });

  test('Reverse Outline shows what each paragraph does, goes to a paragraph, and isn’t asked for again while the piece is the same', async ({ app, page }) => {
    await readingAlong(page, false);
    const api = await fakeApi(page, { outline: { paragraphs: [{ paragraph: 1, does: 'why the writer builds' }, { paragraph: 2, does: 'the flood: the real start' }], point: 2, observations: ['1 delays what 2 is about'] } });
    await writePiece(app);
    await app.menu('Tools', 'Afterward', 'Reverse Outline');
    const dialog = page.getByRole('dialog', { name: 'Reverse Outline' });
    await expect(dialog.getByRole('button', { name: /¶1\s*why the writer builds/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /¶2/ })).toContainText('main point');
    await dialog.getByRole('button', { name: /¶2/ }).click();
    await expect(dialog).toHaveCount(0);
    await app.type('X');
    expect(await app.text()).toBe(`${OPENING}\nX${MIDDLE}`);
    await app.press('ControlOrMeta+z');
    await expect.poll(() => app.text()).toBe(`${OPENING}\n${MIDDLE}`);
    await app.menu('Tools', 'Afterward', 'Reverse Outline');
    await expect(page.getByRole('dialog', { name: 'Reverse Outline' })).toBeVisible();
    expect(api.bodies).toHaveLength(1);
  });

  test('clicking a note puts the keyboard in its box: typing then doesn’t go into the document, and Escape closes the note', async ({ app, page }) => {
    await readingAlong(page);
    await fakeApi(page, { read: [PANACEA] });
    await writePiece(app);
    const card = note(page, 'A panacea cures');
    await card.click();
    const box = card.getByPlaceholder('Ask about this…');
    await expect(box).toBeFocused();
    await page.keyboard.type('why?');
    await expect(box).toHaveValue('why?');
    expect(await app.text()).toBe(`${OPENING}\n${MIDDLE}`);
    await box.press('Escape');
    await expect(card).not.toHaveClass(/wm-comment-active/);
  });
});

guestTest.describe('Afterward: quotes and long pieces', () => {
  guestTest('only words really in a source become quotes, in the source’s own words, in a note beside the selection', async ({ app, page }) => {
    await readingAlong(page, false);
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
    await app.menu('Tools', 'Afterward', 'Find Quotes in My Notes');
    const card = note(page, 'From your notes');
    await expect(card).toContainText('1 passage that bears on this (Flood notes.md)');
    await expect(card).toContainText('“The town had “no plan at all” for the evacuation.”');
    await expect(card).toContainText('— Flood notes.md');
    await expect(page.locator('.wm-comments')).not.toContainText('Every house on the river was lost.');
    expect(api.bodies[1].messages[0].content).toContain('Source 1: Flood notes.md');
    expect(await app.text()).toBe('Nobody in town was ready when the flood came.');
  });

  guestTest('a long piece is read along a chapter at a time, remembering the chapters before and nothing after', async ({ app, page }) => {
    await readingAlong(page);
    const words = (c: number, p: number) => `Chapter ${c} paragraph ${p}. ${'More of the story goes here. '.repeat(40).trim()}`;
    const markdown = ['# The Book', ...[1, 2, 3].flatMap((c) => [`## Chapter ${c}`, ...Array.from({ length: 10 }, (_, p) => words(c, p + 1))])].join('\n\n') + '\n';
    const api = await fakeApi(page, { read: Array.from({ length: 4 }, () => ({ reads_as: 'A story.', notes: [] })) });
    await app.goto('?doc=welcome');
    await importFile(app, textFile('The Book.md', markdown));
    await expect(page.locator('.wm-sync')).toHaveAttribute('data-local', 'saved', { timeout: 15_000 });
    // The cursor in the middle chapter, and an edit there.
    await app.focus();
    await app.menu('Edit', 'Find');
    const find = page.getByRole('dialog', { name: 'Find and Replace' });
    await find.getByRole('textbox', { name: 'Find what' }).fill('Chapter 2 paragraph 3');
    await expect.poll(() => app.selectedText()).toBe('Chapter 2 paragraph 3');
    await page.keyboard.press('Escape');
    await app.focus();
    await app.press('End');
    await app.type('!');
    await expect.poll(() => api.bodies.some((b) => b.system.length === 3 && b.system[2].text.includes('The chapter you are reading now, "Chapter 2"')), { timeout: 20_000 }).toBe(true);
    const body = api.bodies.find((b) => b.system.length === 3 && b.system[2].text.includes('"Chapter 2"'))!;
    expect(body.system[1].text).toContain('Chapter 1 paragraph 10.');
    expect(body.system.map((b) => b.text).join('')).not.toContain('Chapter 3 paragraph');
  });
});
