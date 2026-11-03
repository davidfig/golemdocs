// Every function, loaded: importing this fills the registry.

import { parseDateInput, parseNumberInput } from '../../input.ts';
import { setTextToNumber } from '../values.ts';
import { setCaller } from './math.ts';
import { FUNCTIONS } from './registry.ts';
import './bonds.ts';
import './database.ts';
import './date.ts';
import './dynamic.ts';
import './engineering.ts';
import './ets.ts';
import './financial.ts';
import './info.ts';
import './logical.ts';
import './lookup.ts';
import './misc.ts';
import './regression.ts';
import './statistical.ts';
import './text.ts';

// Text in arithmetic reads as typing does: "1,234", "$5", "50%", dates and times.
setTextToNumber((text) => {
  const t = text.trim();
  if (!t) return null;
  return parseNumberInput(t)?.value ?? parseDateInput(t)?.value ?? null;
});

// SUBTOTAL and AGGREGATE call the statistics functions by name, their arguments already values.
setCaller((name, args, ctx) => FUNCTIONS.get(name)!.fn!(args, ctx));

export { FUNCTIONS };
