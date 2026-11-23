// Writes client/test/fixtures/slides/review.pptx, the deck the slides e2e specs open: two slides made from an outline by the app's
// own blank deck. Run with `node --experimental-transform-types client/test/makeSlidesFixture.ts` after changing the blank deck.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deckFromMarkdown } from '../src/slides/outline.ts';

const out = resolve(import.meta.dirname, 'fixtures/slides/review.pptx');
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, await deckFromMarkdown('# Quarterly review\n\n- Revenue up 12%\n- Two new markets\n  - Brazil\n  - Japan\n\n# Next steps\n\n- Ship slides\n- Celebrate'));
console.log(out);
