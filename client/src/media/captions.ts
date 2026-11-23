// Captions for a media file: the `.vtt` or `.srt` files beside it with the same name (`talk.vtt`, `talk.en.vtt`, `talk.fr.srt`).
// SubRip is turned into WebVTT, the only kind the browser's <track> reads. Agents write transcripts as these files; the app shows them.

/** A caption file found for a media file: its name, and the language its name gives (`talk.en.vtt`), if any. */
export interface CaptionFile {
  name: string;
  language: string | null;
}

const CAPTION_FILE = /\.(vtt|srt)$/i;
const stemOf = (name: string) => name.replace(/\.[^.]*$/, '');

/** The caption files among `names` that belong to the media file `mediaName`, plain one first, then by language. */
export function captionFilesFor(mediaName: string, names: readonly string[]): CaptionFile[] {
  const stem = stemOf(mediaName).toLowerCase();
  const found: CaptionFile[] = [];
  for (const name of names) {
    if (!CAPTION_FILE.test(name)) continue;
    const rest = stemOf(name);
    if (rest.toLowerCase() === stem) found.push({ name, language: null });
    else if (rest.toLowerCase().startsWith(`${stem}.`)) {
      const language = rest.slice(stem.length + 1);
      // A language tag (`en`, `pt-BR`, `zh-Hans`), not another word (`talk.notes.vtt` is someone else's).
      if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(language)) found.push({ name, language });
    }
  }
  return found.sort((a, b) => (a.language === null ? -1 : b.language === null ? 1 : a.language.localeCompare(b.language)));
}

/** Whether a file is SubRip by its name. */
export const isSrtName = (name: string): boolean => /\.srt$/i.test(name);

/**
 * WebVTT from SubRip: cue numbers dropped, `,` in times made `.`, a header added. Text that is WebVTT already is given back as it
 * is. The cue text is kept (SubRip's `<i>`, `<b>` and `<u>` are WebVTT too; its `{\an8}` placement codes are dropped).
 */
export function srtToVtt(text: string): string {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(clean)) return clean;
  const blocks = clean.split(/\n{2,}/);
  const cues: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((line, i) => i > 0 || line.trim() !== '');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const timing = lines[at]!.replace(/(\d+:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2').replace(/(\d+:\d{2}:\d{2})\.(\d{1,2})(?!\d)/g, (_m, clock: string, ms: string) => `${clock}.${ms.padEnd(3, '0')}`);
    const body = lines
      .slice(at + 1)
      .map((line) => line.replace(/\{\\[^}]*\}/g, ''))
      .join('\n')
      .trim();
    if (body) cues.push(`${timing.trim()}\n${body}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
