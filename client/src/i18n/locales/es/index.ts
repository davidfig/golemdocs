// Spanish. One entry module so the whole language builds as a single chunk.

import type { Messages } from '../../index.ts';
import { app } from './app.ts';
import { chrome } from './chrome.ts';
import { dialogs } from './dialogs.ts';
import { link } from './link.ts';
import { menus } from './menus.ts';
import { panels } from './panels.ts';
import { spelling } from './spelling.ts';

export const messages: Partial<Messages> = { ...app, ...chrome, ...dialogs, ...link, ...menus, ...panels, ...spelling };
