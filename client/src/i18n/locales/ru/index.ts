// Russian. One entry module so the whole language builds as a single chunk.

import type { Catalog } from '../../index.ts';
import { app } from './app.ts';
import { assistant } from './assistant.ts';
import { chrome } from './chrome.ts';
import { columns } from './columns.ts';
import { dialogs } from './dialogs.ts';
import { largeText } from './largeText.ts';
import { link } from './link.ts';
import { math } from './math.ts';
import { menus } from './menus.ts';
import { panels } from './panels.ts';
import { paragraph } from './paragraph.ts';
import { picture } from './picture.ts';
import { spelling } from './spelling.ts';
import { table } from './table.ts';
import { vector } from './vector.ts';
import { pageSetup } from './pageSetup.ts';
import { pasteSpecial } from './pasteSpecial.ts';
import { properties } from './properties.ts';
import { wordCount } from './wordCount.ts';

export const messages: Catalog = { ...app, ...assistant, ...chrome, ...columns, ...dialogs, ...largeText, ...link, ...math, ...menus, ...panels, ...picture, ...spelling, ...table, ...vector, ...wordCount, ...pageSetup, ...properties, ...pasteSpecial, ...paragraph };
