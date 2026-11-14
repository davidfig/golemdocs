// What a script sees (docs/live-blocks.md §8): the shape of `meta`, the API its function is given, and what each call
// returns. Types only, for the people and agents who write scripts: a script in a vault may `import type` from here (the
// stripper deletes type imports, so the sandbox never loads anything). The code that gives a script this API is runtime.ts.
//
//   import type { ProducerApi, ScriptMetaInput } from '@golemdocs/script';
//   export const meta: ScriptMetaInput = { name: 'Reading list', reads: ['Books/'] };
//   export default async function (api: ProducerApi) {
//     const books = await api.notes('Books/');
//     return api.table(['Title', 'Rating'], books.map((b) => [b.title, b.fields.rating ?? '']));
//   }

export type { ScriptTrigger } from './host.ts';
import type { ScriptTrigger } from './host.ts';

/** What a script exports as `meta`: plain data, read before it runs, which a person allows. */
export interface ScriptMetaInput {
  /** Shown in the app; the file's name when absent. */
  name?: string;
  /** Folders it reads (`Books/`; `/` for the whole vault). */
  reads?: string | string[];
  /** Folders it changes: an action only. */
  writes?: string | string[];
  /** Sites it fetches from, by host name (`api.example.com`): an action only. */
  network?: string | string[];
  /** When an action runs by itself: every day, every week, or when a document in a folder changes. */
  trigger?: ScriptTrigger;
}

/** The date as the app gives it: the same for every run on a day. A producer cannot read the clock otherwise. */
export interface Today {
  /** `2026-11-12`. */
  iso: string;
  year: number;
  month: number;
  day: number;
  /** 1 (Monday) to 7 (Sunday). */
  weekday: number;
  /** `Thursday, November 12, 2026`. */
  long: string;
}

/** A note as a script reads it: its text as Markdown, and its front matter fields. */
export interface Note {
  path: string;
  /** The file's name without its extension. */
  title: string;
  text: string;
  fields: Record<string, string>;
}

/** What a live block shows: what a producer returns (a string or number is a value). */
export type ScriptResult =
  | { kind: 'table'; rows: string[][]; header: boolean }
  | { kind: 'value'; text: string }
  | { kind: 'markdown'; markdown: string };

/** Another source's result, read by `sheet()` or `result()`. */
export type ReadResult =
  | { kind: 'table'; rows: string[][]; header: boolean }
  | { kind: 'value'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'picture'; width: number; height: number };

/** What every script is given. */
export interface ScriptApi {
  /** The notes in a folder (scripts left out), by path. The folder must be in `meta.reads`. */
  notes(folder: string): Promise<Note[]>;
  /** One note, or null when there is none. Its folder must be in `meta.reads`. */
  read(path: string): Promise<Note | null>;
  /** A part of a spreadsheet or another source, as a live block would show it: `Budget.xlsx#Summary!A1:C4`. */
  sheet(address: string): Promise<ReadResult>;
  /** Another producer's result: `Scripts/reading.ts`. */
  result(path: string): Promise<ReadResult>;
  readonly today: Today;
  /** A table with a header row. */
  table(header: unknown[], rows: unknown[][]): ScriptResult;
  /** A table without one. */
  rows(rows: unknown[][]): ScriptResult;
  value(value: unknown): ScriptResult;
  markdown(markdown: string): ScriptResult;
  /** A bulleted list. */
  list(items: unknown[]): ScriptResult;
}

/** A producer fills live blocks: same files, same result. No clock, no network, and `Math.random` repeats. */
export type ProducerApi = ScriptApi;

/** A document an action opened. Nothing is written until the run ends; each helper returns the document. */
export interface ScriptDocument {
  readonly path: string;
  readonly title: string;
  /** Its text as Markdown, with this run's changes. */
  readonly text: string;
  readonly fields: Record<string, string>;
  readonly isEmpty: boolean;
  append(markdown: string): ScriptDocument;
  prepend(markdown: string): ScriptDocument;
  replace(markdown: string): ScriptDocument;
  /** Sets a front matter field; null removes it. */
  setField(key: string, value: unknown): ScriptDocument;
  /** Adds to the end of the section under a heading; the run fails when there is no such heading. */
  appendToSection(heading: string, markdown: string): ScriptDocument;
  /** Replaces what is under a heading, keeping the heading. */
  replaceSection(heading: string, markdown: string): ScriptDocument;
}

/** A response from a site the action named in `meta.network`. */
export interface ScriptFetchResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** An action changes documents: by hand, from a button, on a trigger or a schedule. */
export interface ActionApi extends ScriptApi {
  /** When it runs, ISO. */
  readonly now: string;
  /** Opens a document in a folder of `meta.writes`; with `create`, makes it when it is not there. */
  open(path: string, options?: { create?: boolean }): Promise<ScriptDocument>;
  /** Makes a document; an error when it is already there. */
  create(path: string, markdown?: string): Promise<ScriptDocument>;
  /** Fetches from a site in `meta.network`: no cookies, no redirects, 20 seconds at most. */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<ScriptFetchResponse>;
}
