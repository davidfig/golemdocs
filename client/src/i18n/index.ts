// Localization: every string the user reads goes through `t()`.
//
// English is the source catalog (./en) and is always loaded. Other languages are lazily loaded
// catalogs (./locales.ts) that may leave keys out: a missing key falls back to English, so a
// half-finished translation still works.
//
// Placeholders are `{name}`. Counts use plural variants: when `params.count` is given, `t('x')`
// looks for `x.zero|one|two|few|many|other` (whichever Intl.PluralRules picks for the language),
// then `x.other`, then `x`. Menu labels keep their `&mnemonic` marker inside the string, so a
// translation chooses its own mnemonic letter.

import type { en } from './en/index.ts';
import { LOCALES } from './locales.ts';

/** Every catalog key, each holding text (not the English literal, or no translation could match). */
export type Messages = { [K in keyof typeof en]: string };
/** A key, or the base of a `.one`/`.other` plural family (`t('x', { count })` finds `x.other`). */
export type MessageKey = keyof Messages | (keyof Messages extends infer K ? (K extends `${infer B}.other` ? B : never) : never);
export type Params = Record<string, string | number>;

const STORAGE_KEY = 'wm.locale';
const SOURCE_LOCALE = 'en';

let current: string = SOURCE_LOCALE;
let catalog: Partial<Record<string, string>> = {};
/** English, loaded with the first language (its own chunk, so the layout worker doesn't carry it inline). */
let english: Record<string, string> = {};
let plurals = new Intl.PluralRules(SOURCE_LOCALE);

/** The language messages are shown in (a BCP 47 tag such as `en` or `pt-BR`). */
export const getLocale = (): string => current;

/** Fills `{name}` placeholders; an unknown name is left as written so the gap is visible. */
export function format(message: string, params?: Params): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

function lookup(key: string, count: number | undefined): string {
  const pick = (k: string) => catalog[k] ?? english[k];
  if (count !== undefined) {
    const found = pick(`${key}.${plurals.select(count)}`) ?? pick(`${key}.other`);
    if (found !== undefined) return found;
  }
  return pick(key) ?? key;
}

/** The message for `key` in the current language. */
export function t(key: MessageKey, params?: Params): string {
  const count = params && typeof params.count === 'number' ? params.count : undefined;
  return format(lookup(key, count), params);
}

/** Best supported language for a list of preferences (`navigator.languages`), else English. */
export function pickLocale(preferred: readonly string[]): string {
  const ids = Object.keys(LOCALES);
  const serves = (id: string, tag: string) => id.toLowerCase() === tag || (LOCALES[id].aliases ?? []).includes(tag);
  for (const tag of preferred) {
    const lower = tag.toLowerCase();
    // zh-Hant-TW, then zh-Hant, then zh.
    for (let tagged = lower; tagged; tagged = tagged.includes('-') ? tagged.slice(0, tagged.lastIndexOf('-')) : '') {
      const found = ids.find((id) => serves(id, tagged));
      if (found) return found;
    }
  }
  return SOURCE_LOCALE;
}

/** Loads a language's catalog and makes it current. No DOM: this is also how the layout worker follows the page. */
export async function loadLocale(id: string): Promise<string> {
  const locale = LOCALES[id];
  if (!locale) id = SOURCE_LOCALE;
  if (!Object.keys(english).length) english = (await import('./en/index.ts')).en;
  catalog = locale && id !== SOURCE_LOCALE ? await locale.load().catch(() => ({})) : {};
  current = id;
  plurals = new Intl.PluralRules(id);
  return id;
}

/** Switches the page's language: loads its catalog, then updates `<html lang>` and `dir`. Remembered. */
export async function setLocale(requested: string): Promise<void> {
  const id = await loadLocale(requested);
  document.documentElement.lang = id;
  document.documentElement.dir = LOCALES[id]?.dir ?? 'ltr';
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode: the language is just not remembered.
  }
}

/** Picks the remembered language, else the browser's. Call once before building any UI. */
export async function initLocale(): Promise<void> {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  await setLocale(saved && LOCALES[saved] ? saved : pickLocale(navigator.languages ?? [navigator.language]));
}
