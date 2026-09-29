// The languages the app is translated into. English is the source (./en). To add a language, see
// docs/localization.md. Each catalog is its own lazily loaded chunk.

import type { Catalog } from './index.ts';

export interface LocaleInfo {
  /** The language's own name, shown in the language picker. */
  name: string;
  dir?: 'rtl';
  /** Browser language tags (lower case, or just the prefix before `-`) this catalog serves besides its own id. */
  aliases?: string[];
  load: () => Promise<Catalog>;
}

export const LOCALES: Record<string, LocaleInfo> = {
  en: { name: 'English', load: async () => ({}) },
  es: {
    name: 'Español',
    load: async () => (await import('./locales/es/index.ts')).messages,
  },
  ru: {
    name: 'Русский',
    load: async () => (await import('./locales/ru/index.ts')).messages,
  },
  de: {
    name: 'Deutsch',
    load: async () => (await import('./locales/de/index.ts')).messages,
  },
  fr: {
    name: 'Français',
    load: async () => (await import('./locales/fr/index.ts')).messages,
  },
  ja: {
    name: '日本語',
    load: async () => (await import('./locales/ja/index.ts')).messages,
  },
  'pt-BR': {
    name: 'Português (Brasil)',
    aliases: ['pt', 'pt-pt'],
    load: async () => (await import('./locales/pt-BR/index.ts')).messages,
  },
  'zh-Hant': {
    name: '繁體中文',
    aliases: ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'],
    load: async () => (await import('./locales/zh-Hant/index.ts')).messages,
  },
  'zh-Hans': {
    name: '简体中文',
    aliases: ['zh', 'zh-cn', 'zh-sg', 'zh-hans'],
    load: async () => (await import('./locales/zh-Hans/index.ts')).messages,
  },
  it: {
    name: 'Italiano',
    load: async () => (await import('./locales/it/index.ts')).messages,
  },
  ko: {
    name: '한국어',
    load: async () => (await import('./locales/ko/index.ts')).messages,
  },
};
