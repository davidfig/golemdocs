// A script and the scripts it imports, made into one program the sandbox can load (docs/live-blocks.md §8, *Scripts build
// on scripts*). Each file's types are stripped (strip.ts), and each import of another script (by a relative path, inside
// `Scripts/`) is pointed at that script's own `data:` module, so the sandbox loads nothing from anywhere. No packages and
// no URLs: anything else is an error, as is a cycle of imports.

import { say } from './messages.ts';
import { stripTypes } from './strip.ts';
import { ScriptSyntaxError, lineAt, tokenize } from './tokens.ts';

/** Where scripts live in the vault. */
export const SCRIPTS_FOLDER = 'Scripts';

/** Whether a vault path names a script. */
export const isScriptPath = (path: string): boolean => /^Scripts\/(?:[^/]+\/)*[^/]+\.(?:ts|js|mts|mjs)$/i.test(path);

export class ScriptError extends Error {
  constructor(
    message: string,
    /** The script it is about, and the line, when known. */
    readonly path: string,
    readonly line?: number,
  ) {
    super(line ? say('atLine', { path, line, message }) : say('at', { path, message }));
  }
}

export interface LinkedProgram {
  /** The entry script's module, with the others it imports inside it. */
  url: string;
  /** Every script in the program, the entry first. */
  files: string[];
}

/** A path relative to the importing script, as a vault path; null when it leaves the vault. */
export function resolvePath(from: string, specifier: string): string | null {
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

/** The imports in a module's JavaScript: each module name's place in the text. */
function imports(js: string): { start: number; end: number; name: string }[] {
  const tokens = tokenize(js);
  const found: { start: number; end: number; name: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'string') continue;
    const prev = tokens[i - 1];
    const before = tokens[i - 2];
    const isImport = (prev?.kind === 'name' && (prev.text === 'from' || (prev.text === 'import' && tokens[i - 2]?.text !== '.'))) || (prev?.text === '(' && before?.kind === 'name' && before.text === 'import' && tokens[i + 1]?.text === ')');
    if (isImport) found.push({ start: token.start, end: token.end, name: token.text.slice(1, -1).replace(/\\(.)/g, '$1') });
  }
  return found;
}

/** The module text a `data:` URL holds, named for errors and the debugger. */
const moduleUrl = (js: string, path: string): string => `data:text/javascript;charset=utf-8,${encodeURIComponent(`${js}\n//# sourceURL=golem:///${path}`)}`;

/**
 * Links the script at `entry` (a vault path under `Scripts/`) with the scripts it imports, read with `load` (null when there
 * is no such script).
 */
export async function linkScript(entry: string, load: (path: string) => Promise<string | null>): Promise<LinkedProgram> {
  const urls = new Map<string, string>();
  const files: string[] = [];
  const visiting: string[] = [];
  const visit = async (path: string, importedFrom?: { path: string; line: number }): Promise<string> => {
    const done = urls.get(path);
    if (done) return done;
    if (visiting.includes(path)) throw new ScriptError(say('importCycle', { chain: [...visiting.slice(visiting.indexOf(path)), path].join(' → ') }), importedFrom?.path ?? path, importedFrom?.line);
    const text = await load(path);
    if (text === null) {
      if (importedFrom) throw new ScriptError(say('noScriptAt', { path }), importedFrom.path, importedFrom.line);
      throw new ScriptError(say('noScript'), path);
    }
    visiting.push(path);
    files.push(path);
    let js: string;
    let found: ReturnType<typeof imports>;
    try {
      js = /\.m?js$/i.test(path) ? text : stripTypes(text);
      found = imports(js);
    } catch (e) {
      if (e instanceof ScriptSyntaxError) throw new ScriptError(e.message.replace(/ \(line \d+\)$/, ''), path, e.line);
      throw e;
    }
    // Each import pointed at its module, from the last so the places before it stay where they are.
    let out = js;
    for (const place of [...found].reverse()) {
      const line = lineAt(js, place.start);
      if (!place.name.startsWith('./') && !place.name.startsWith('../')) throw new ScriptError(say('relativeImport', { name: place.name }), path, line);
      let target = resolvePath(path, place.name);
      if (target && !/\.(?:ts|js|mts|mjs)$/i.test(target)) target += '.ts';
      if (!target || !isScriptPath(target)) throw new ScriptError(say('outsideScripts', { name: place.name, folder: SCRIPTS_FOLDER }), path, line);
      const url = await visit(target, { path, line });
      out = out.slice(0, place.start) + JSON.stringify(url) + out.slice(place.end);
    }
    visiting.pop();
    const url = moduleUrl(out, path);
    urls.set(path, url);
    return url;
  };
  if (!isScriptPath(entry)) throw new ScriptError(say('notAScript', { folder: SCRIPTS_FOLDER }), entry);
  const url = await visit(entry);
  return { url, files };
}
