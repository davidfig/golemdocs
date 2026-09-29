// Italian. One entry module so the whole language builds as a single chunk.

import type { Messages } from '../../index.ts';
import { app } from './app.ts';
import { chrome } from './chrome.ts';
import { columns } from './columns.ts';
import { dialogs } from './dialogs.ts';
import { largeText } from './largeText.ts';
import { link } from './link.ts';
import { menus } from './menus.ts';
import { panels } from './panels.ts';
import { picture } from './picture.ts';
import { spelling } from './spelling.ts';
import { table } from './table.ts';
import { pageSetup } from './pageSetup.ts';
import { pasteSpecial } from './pasteSpecial.ts';
import { properties } from './properties.ts';
import { wordCount } from './wordCount.ts';

export const messages: Partial<Messages> = { ...app, ...chrome, ...columns, ...dialogs, ...largeText, ...link, ...menus, ...panels, ...picture, ...spelling, ...table, ...wordCount, ...pageSetup, ...properties, ...pasteSpecial };
