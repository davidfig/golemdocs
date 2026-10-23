// Brazilian Portuguese. One entry module so the whole language builds as a single chunk.

import type { Messages } from '../../index.ts';
import { app } from './app.ts';
import { chrome } from './chrome.ts';
import { columns } from './columns.ts';
import { dialogs } from './dialogs.ts';
import { history } from './history.ts';
import { textEditor } from './textEditor.ts';
import { link } from './link.ts';
import { math } from './math.ts';
import { menus } from './menus.ts';
import { paragraph } from './paragraph.ts';
import { pasteSpecial } from './pasteSpecial.ts';
import { properties } from './properties.ts';
import { panels } from './panels.ts';
import { picture } from './picture.ts';
import { spelling } from './spelling.ts';
import { table } from './table.ts';
import { vault } from './vault.ts';
import { vector } from './vector.ts';
import { pageSetup } from './pageSetup.ts';
import { wordCount } from './wordCount.ts';

export const messages: Partial<Messages> = { ...app, ...chrome, ...columns, ...dialogs, ...history, ...textEditor, ...link, ...math, ...menus, ...panels, ...picture, ...spelling, ...table, ...vault, ...vector, ...wordCount, ...pageSetup, ...properties, ...pasteSpecial, ...paragraph };
