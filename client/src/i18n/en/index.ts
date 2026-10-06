// The English catalog, the source every translation is made from. One file per area of the UI;
// keys are `area.name` and unique across the files (test/i18n.test.ts checks).

import { app } from './app.ts';
import { assistant } from './assistant.ts';
import { chrome } from './chrome.ts';
import { columns } from './columns.ts';
import { dialogs } from './dialogs.ts';
import { history } from './history.ts';
import { textEditor } from './textEditor.ts';
import { link } from './link.ts';
import { math } from './math.ts';
import { menus } from './menus.ts';
import { pageSetup } from './pageSetup.ts';
import { panels } from './panels.ts';
import { paragraph } from './paragraph.ts';
import { pasteSpecial } from './pasteSpecial.ts';
import { picture } from './picture.ts';
import { properties } from './properties.ts';
import { spelling } from './spelling.ts';
import { table } from './table.ts';
import { vector } from './vector.ts';
import { wordCount } from './wordCount.ts';

export const catalogs = [app, assistant, chrome, columns, dialogs, history, textEditor, link, math, menus, pageSetup, panels, paragraph, pasteSpecial, picture, properties, spelling, table, vector, wordCount] as const;

export const en = Object.assign({}, ...catalogs) as UnionToIntersection<(typeof catalogs)[number]>;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
