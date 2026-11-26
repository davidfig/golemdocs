// Help for every worksheet function (Insert › Function and the hint under a formula being typed): its arguments and
// what it does, in the app's language. Each language is its own module, fetched the first time help is needed, so a
// session pays only for its own language. See docs/spreadsheets.md, "Function help".

/**
 * By function name (in English, as formulas are written): its arguments, separated by ", " (optional ones in [ ], a
 * bracketed group that repeats, and … when more may follow), and one sentence on what it does.
 */
export type FunctionHelp = Readonly<Record<string, readonly [args: string, description: string]>>;

const LOADERS: Record<string, () => Promise<{ HELP: FunctionHelp }>> = {
  en: () => import('./en.ts'),
  de: () => import('./de.ts'),
  es: () => import('./es.ts'),
  fr: () => import('./fr.ts'),
  it: () => import('./it.ts'),
  ja: () => import('./ja.ts'),
  ko: () => import('./ko.ts'),
  'pt-BR': () => import('./pt-BR.ts'),
  ru: () => import('./ru.ts'),
  'zh-Hans': () => import('./zh-Hans.ts'),
  'zh-Hant': () => import('./zh-Hant.ts'),
};

/** The languages there is help in. */
export const HELP_LANGUAGES = Object.keys(LOADERS);

const loaded = new Map<string, Promise<FunctionHelp>>();

/** The help in a language (the app's locale tag), or English when there is none in it. */
export function functionHelp(locale: string): Promise<FunctionHelp> {
  const tag = LOADERS[locale] ? locale : LOADERS[locale.split('-')[0]] ? locale.split('-')[0] : 'en';
  let help = loaded.get(tag);
  if (!help) {
    help = LOADERS[tag]().then((m) => m.HELP);
    loaded.set(tag, help);
  }
  return help;
}

/** A function's arguments, one string each, from its help's argument list (a bracketed group is one). */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = args.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/**
 * Which of a function's listed arguments (`splitArgs`) the `n`th argument typed (from 0) falls on: past the listed ones,
 * the one that repeats (the one before …, which may be a bracketed group), or else the last.
 */
export function argumentIndex(args: readonly string[], n: number): number {
  const more = args.indexOf('…');
  const listed = more < 0 ? args.length : more;
  if (n < listed) return n;
  return more > 0 ? more - 1 : Math.max(0, args.length - 1);
}
