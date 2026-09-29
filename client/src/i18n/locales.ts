// The languages the app is translated into. English is the source (./en); to add a language,
// copy a catalog file's keys into `locales/<tag>.ts` (a `Partial<Messages>`: leave out what isn't
// translated yet) and list it here. Each catalog is its own lazily loaded chunk.

import type { Messages } from './index.ts';

export interface LocaleInfo {
  /** The language's own name, shown in the language picker. */
  name: string;
  dir?: 'rtl';
  /** Browser language tags (lower case, or just the prefix before `-`) this catalog serves besides its own id. */
  aliases?: string[];
  load: () => Promise<Partial<Messages>>;
}

export const LOCALES: Record<string, LocaleInfo> = {
  en: { name: 'English', load: async () => ({}) },
  es: {
    name: 'Español',
    load: async () => (await import('./locales/es/index.ts')).messages,
  },
  'zh-Hant': {
    name: '繁體中文',
    aliases: ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'],
    load: async () => (await import('./locales/zh-Hant/index.ts')).messages,
  },
};
