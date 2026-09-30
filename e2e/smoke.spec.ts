import { expect, test } from './fixtures';

test('the app starts on the welcome document', async ({ app }) => {
  await app.goto('?doc=welcome');
  await expect(app.menubar).toBeVisible();
  expect(await app.text()).toContain('Welcome to Golem Docs');
});

test('a new document takes typing and reads it back', async ({ app }) => {
  await app.blank();
  await app.type('Hello world');
  expect(await app.text()).toBe('Hello world');
  await app.press('Enter');
  await app.type('Second');
  expect(await app.text()).toBe('Hello world\nSecond');
});
