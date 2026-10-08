// pnpm og:image: draws the 1200x630 card shown when a Golem Docs link is shared (client/public/og.png).
// It renders a small HTML page in Chromium (the one Playwright installs), so nothing else is needed.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'client/public/og.png');
const icon = path.join(root, 'client/public/favicon.svg');

const html = `<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: Carlito; font-weight: 400; src: url(file://${root}/client/public/fonts/calibri/regular.ttf); }
  @font-face { font-family: Carlito; font-weight: 700; src: url(file://${root}/client/public/fonts/calibri/bold.ttf); }
  * { box-sizing: border-box; }
  body { margin: 0; width: 1200px; height: 630px; display: grid; grid-template-columns: 1fr 440px; gap: 40px; align-items: center; padding: 0 72px; background: #2f5496; color: #fff; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; overflow: hidden; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 700; margin-bottom: 36px; }
  .brand img { width: 48px; height: 48px; }
  h1 { margin: 0 0 26px; font-size: 68px; line-height: 1.06; letter-spacing: -0.02em; }
  p { margin: 0; font-size: 29px; line-height: 1.35; opacity: 0.9; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 34px; }
  .chips span { padding: 6px 16px; border: 2px solid rgb(255 255 255 / 0.55); border-radius: 999px; font-size: 22px; font-weight: 600; }
  .sheet { background: #fff; color: #000; border-radius: 4px; padding: 34px 36px; font: 400 21px/1.32 Carlito, Calibri, sans-serif; transform: rotate(-2deg); box-shadow: 0 18px 50px rgb(0 0 0 / 0.35); height: 440px; }
  .sheet h2 { margin: 0 0 12px; font-size: 40px; font-weight: 400; color: #2f5496; }
  .sheet i { display: inline-block; width: 2px; height: 1em; background: #000; vertical-align: -0.12em; }
  .bar { height: 12px; border-radius: 6px; background: #e3e6ec; margin: 11px 0; }
</style>
<div>
  <div class="brand"><img src="file://${icon}">Golem Docs</div>
  <h1>One editor for every document</h1>
  <p>Edit Word, PDF, Markdown and more in your browser. Free, no account, nothing uploaded.</p>
  <div class="chips"><span>.docx</span><span>PDF</span><span>Markdown</span><span>SVG</span><span>ZIP</span></div>
</div>
<div class="sheet"><h2>Grandma's lasagna</h2><div class="bar" style="width:96%"></div><div class="bar" style="width:88%"></div><div class="bar" style="width:93%"></div><div class="bar" style="width:55%"></div><div class="bar" style="width:0;height:6px"></div><div class="bar" style="width:92%"></div><div class="bar" style="width:84%"></div><div class="bar" style="width:40%"></div><i></i></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
writeFileSync(path.join(root, 'client/public/.og.html'), html);
await page.goto(`file://${root}/client/public/.og.html`);
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();
import('node:fs').then(({ rmSync }) => rmSync(path.join(root, 'client/public/.og.html')));
console.log('wrote', out);
