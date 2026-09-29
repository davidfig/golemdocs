import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Paragraph } from '@word/docx';
import { markdownToDocument } from '../src/formats/markdown.ts';

const links = async (md: string): Promise<string[]> => {
  const doc = await markdownToDocument(md);
  const urls: string[] = [];
  for (const block of doc.body) {
    if (block.kind !== 'paragraph') continue;
    for (const child of (block as Paragraph).children) if (child.kind === 'hyperlink' && child.url) urls.push(child.url);
  }
  return urls;
};

test('the welcome text links to the privacy policy and terms by their app paths', async () => {
  const welcome = readFileSync(new URL('../src/layout/welcome/en.md', import.meta.url), 'utf8');
  const urls = await links(welcome);
  assert.ok(urls.includes('/privacy'));
  assert.ok(urls.includes('/terms'));
});

test('the privacy policy and terms link to each other', async () => {
  for (const [page, other] of [['privacy', '/terms'], ['terms', '/privacy']]) {
    const md = readFileSync(new URL(`../src/layout/legal/${page}/en.md`, import.meta.url), 'utf8');
    assert.ok((await links(md)).includes(other), page);
  }
});
