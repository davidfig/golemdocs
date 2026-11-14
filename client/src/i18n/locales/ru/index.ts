// Russian. One entry module so the whole language builds as a single chunk.

import type { Catalog } from '../../index.ts';
import { a11y } from './a11y.ts';
import { a11ySheet } from './a11ySheet.ts';
import { app } from './app.ts';
import { chrome } from './chrome.ts';
import { columns } from './columns.ts';
import { dialogs } from './dialogs.ts';
import { history } from './history.ts';
import { textEditor } from './textEditor.ts';
import { sheet } from './sheet.ts';
import { link } from './link.ts';
import { live } from './live.ts';
import { scripts } from './scripts.ts';
import { math } from './math.ts';
import { menus } from './menus.ts';
import { panels } from './panels.ts';
import { format } from './format.ts';
import { paragraph } from './paragraph.ts';
import { picture } from './picture.ts';
import { spelling } from './spelling.ts';
import { table } from './table.ts';
import { vault } from './vault.ts';
import { vector } from './vector.ts';
import { viewer } from './viewer.ts';
import { pageSetup } from './pageSetup.ts';
import { pasteSpecial } from './pasteSpecial.ts';
import { properties } from './properties.ts';
import { wordCount } from './wordCount.ts';

export const messages: Catalog = { ...a11y, ...a11ySheet, ...app, ...chrome, ...columns, ...dialogs, ...history, ...textEditor, ...sheet, ...link, ...live, ...scripts, ...math, ...menus, ...panels, ...picture, ...spelling, ...table, ...vault, ...vector, ...viewer, ...wordCount, ...pageSetup, ...properties, ...pasteSpecial, ...format, ...paragraph };
