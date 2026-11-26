// A shared HTML page (docs/html-pages.md §5): the owner's app keeps what the page showed (its embeds, and what its script read), and
// someone with the public link sees the page with that, in the same sandboxed frame, though they can't read the owner's documents.

import { test, expect } from '../fixtures';
import { newPerson, openCloud, signedOutContext, uploadDoc } from './helpers';

const PAGE = `<!doctype html><html><head><title>Board</title></head><body>
<golem-embed src="Goals.md#Goals"></golem-embed>
<p id="out">waiting</p>
<button id="add" type="button">Add</button>
<script>
  document.getElementById('add').addEventListener('click', () => golem.append('Goals.md', 'Tidy the vault.').then(() => { document.body.dataset.added = 'yes'; }));
  golem.read('Goals.md').then((n) => { document.getElementById('out').textContent = 'read: ' + n.title; }, (e) => { document.getElementById('out').textContent = 'refused: ' + e.message; });
</script>
</body></html>`;

test('a page shared by its public link shows what it last showed its owner', async ({ browser }) => {
  const owner = await newPerson(browser, 'owner');
  await owner.page.goto('/?doc=welcome');
  await uploadDoc(owner.page, 'Goals.md', Buffer.from('# Goals\n\nShip pages.\n'));
  const page = await uploadDoc(owner.page, 'Board.html', Buffer.from(PAGE));
  await openCloud(owner.page, page.id);
  const frame = owner.page.frameLocator('iframe.wm-page-frame');
  await expect(frame.locator('golem-embed')).toContainText('Ship pages.');
  await expect(frame.locator('#out')).toHaveText('read: Goals');
  // A change to a note only the account had goes to that note, not to a new one.
  await frame.getByRole('button', { name: 'Add' }).click();
  await expect(frame.locator('body[data-added="yes"]')).toHaveCount(1);
  await expect.poll(async () => {
    const listed = (await (await owner.page.request.get('/api/documents')).json()) as { name: string }[];
    return listed.filter((d) => d.name === 'Goals.md').length;
  }).toBe(1);
  await expect(frame.locator('golem-embed')).toContainText('Ship pages.');
  // Kept for the people it is shared with once it settles.
  await expect.poll(async () => (await owner.page.request.get(`/api/documents/${page.id}/page`)).status(), { timeout: 15_000 }).toBe(200);

  await owner.app.menu('File', 'Share');
  const dialog = owner.page.locator('dialog.wm-share');
  await expect(dialog.getByText(/This page shows parts of other documents.*Goals\.md/)).toBeVisible();
  await dialog.getByLabel('Anyone with the link can view').check();
  const url = await dialog.getByRole('textbox', { name: 'Public link' }).inputValue();

  const stranger = await signedOutContext(browser);
  const reader = await stranger.newPage();
  await reader.goto(url);
  const shared = reader.frameLocator('iframe.wm-page-frame');
  await expect(shared.locator('golem-embed')).toContainText('Ship pages.');
  await expect(shared.locator('#out')).toHaveText('read: Goals');
  await expect(reader.getByRole('toolbar', { name: 'Page' })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Mark as Mine…' })).toBeHidden();
});
