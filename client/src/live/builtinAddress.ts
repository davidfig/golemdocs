// Built-in blocks' addresses (docs/live-blocks.md §7, producers in builtins.ts): read and written here, apart from the
// producers, so the vault graph and the Insert › Live Block dialog can use them without fetching the producers' chunk.
//
//   @list:Characters?columns=role,status&sort=-status&where=status:alive
//   @count:Novel?of=words&goal=50000
//   @timeline:History?date=date&columns=place

export type BuiltinKind = 'list' | 'count' | 'timeline';

export interface Builtin {
  kind: BuiltinKind;
  /** The folder (or, for a count, the document) it is about, as written. */
  target: string;
  options: Map<string, string>;
}

const BUILTIN = /^\s*@(list|count|timeline):([^?]*)(?:\?(.*))?$/is;

/** Whether a source is a built-in block's address. */
export const isBuiltin = (source: string): boolean => BUILTIN.test(source);

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** An address's options, the part after `?` (`columns=role&sort=-age`), by name; later ones win. */
export function readOptions(query: string): Map<string, string> {
  const options = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair.trim()) continue;
    const eq = pair.indexOf('=');
    options.set(decode(eq < 0 ? pair : pair.slice(0, eq)).trim().toLowerCase(), eq < 0 ? '' : decode(pair.slice(eq + 1)).trim());
  }
  return options;
}

/** What may not appear as it is in an address (it would end the option, the address or the link). */
const escape = (s: string) => s.replace(/[%&?=#|\]\[]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/** Options written after `?` (the inverse of readOptions; empty ones are left out); '' when there are none. */
export function writeOptions(options: Record<string, string | undefined>): string {
  const query = Object.entries(options)
    .filter((e): e is [string, string] => !!e[1]?.trim())
    .map(([k, v]) => `${k}=${escape(v.trim())}`)
    .join('&');
  return query ? `?${query}` : '';
}

/** A built-in block's address, read; null when it is not one. */
export function parseBuiltin(source: string): Builtin | null {
  const m = BUILTIN.exec(source);
  if (!m) return null;
  return { kind: m[1].toLowerCase() as BuiltinKind, target: decode(m[2]).trim(), options: readOptions(m[3] ?? '') };
}

/** A built-in block's address, written (the inverse of parseBuiltin; empty options are left out). */
export function builtinAddress(kind: BuiltinKind, target: string, options: Record<string, string | undefined>): string {
  return `@${kind}:${escape(target.trim())}${writeOptions(options)}`;
}

/** What a built-in block reads: the folder it lists, or the document it counts (both tried, for a count of words). */
export function builtinReads(source: string): { folder: string; document: string | null } | null {
  const block = parseBuiltin(source);
  if (!block) return null;
  return { folder: block.target, document: block.kind === 'count' && block.target ? block.target : null };
}
