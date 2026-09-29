// The English catalog, the source every translation is made from. One file per area of the UI;
// keys are `area.name` and unique across the files (test/i18n.test.ts checks).

import { app } from './app.ts';
import { chrome } from './chrome.ts';
import { dialogs } from './dialogs.ts';
import { link } from './link.ts';
import { menus } from './menus.ts';
import { panels } from './panels.ts';
import { spelling } from './spelling.ts';

export const catalogs = [app, chrome, dialogs, link, menus, panels, spelling] as const;

export const en = Object.assign({}, ...catalogs) as UnionToIntersection<(typeof catalogs)[number]>;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
