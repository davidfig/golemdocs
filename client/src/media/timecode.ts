// Times in media: `#t=` in a link (`[[talk.mp4#t=12:30]]`, `#t=750`, `#t=12:30-13:00`), and times as the player shows them.
// The fragment follows Media Fragments (`t=start,end` in seconds) and also takes clock times and a dash, as people write them.

/** A moment, or a stretch, in seconds. */
export interface MediaMoment {
  start: number;
  /** Where to stop, for a stretch. */
  end?: number;
}

/** Seconds from `750`, `750.5`, `12:30`, `1:02:03` or `1h2m3s`; null if it is none of these. */
export function parseClock(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) {
    const parts = s.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  return null;
}

/** The moment a fragment names (`t=12:30`, `t=750,800`, `t=12:30-13:00`, `t=npt:10`, with or without the `#`), or null. */
export function parseMoment(fragment: string): MediaMoment | null {
  const match = /^#?t=(?:npt:)?([^&]*)/.exec(fragment.trim());
  if (!match) return null;
  const [from, to, ...rest] = match[1]!.split(/,|(?<=\d)-(?=\d)/);
  if (rest.length) return null;
  // `t=,20` plays from the start to 20 s.
  const start = from === '' && to !== undefined ? 0 : parseClock(from ?? '');
  if (start === null) return null;
  if (to === undefined || to === '') return { start };
  const end = parseClock(to);
  return end !== null && end > start ? { start, end } : null;
}

/** Splits a link's title from a moment in it: `talk.mp4#t=12:30` is `talk.mp4` at 750 s. Any other `#part` stays with the title. */
export function splitMoment(title: string): { title: string; moment: MediaMoment | null } {
  const hash = title.lastIndexOf('#');
  if (hash < 0) return { title, moment: null };
  const moment = parseMoment(title.slice(hash + 1));
  return moment ? { title: title.slice(0, hash), moment } : { title, moment: null };
}

/** A time as a clock: `0:05`, `12:30`, `1:02:03`; `total` decides whether hours show (so the two sides of `12:30 / 1:02:03` line up). */
export function formatClock(seconds: number, total = seconds): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 || total >= 3600 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The fragment for a link to a moment (whole seconds, as a clock): `t=12:30`. */
export function momentFragment(moment: MediaMoment): string {
  const start = formatClock(moment.start);
  return moment.end !== undefined ? `t=${start}-${formatClock(moment.end)}` : `t=${start}`;
}

/** Hours, minutes and seconds of a time, for saying it aloud (`t('media.spoken...')` puts the words around them). */
export function clockParts(seconds: number): { hours: number; minutes: number; seconds: number } {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return { hours: Math.floor(whole / 3600), minutes: Math.floor((whole % 3600) / 60), seconds: whole % 60 };
}
