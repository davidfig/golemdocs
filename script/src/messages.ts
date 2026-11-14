// What the script package says when a script can't be read or run (docs/live-blocks.md §8): its English, which the app
// replaces with the person's language (`setScriptMessages`, from client/src/scripts/messages.ts) and the command line keeps.
// The sandbox's runtime can't import this (runtime.ts is sent to its worker as text), so the app hands it the ones it says
// (`RUNTIME_MESSAGES`) with each run.

export const SCRIPT_MESSAGES = {
  // Where a message is (link.ts, tokens.ts, host.ts).
  at: '{path}: {message}',
  atLine: '{path}, line {line}: {message}',
  syntaxLine: '{message} (line {line})',
  // Reading a script (tokens.ts, strip.ts).
  templateOpen: 'A template literal is not closed',
  commentOpen: 'A comment is not closed',
  stringOpen: 'A string is not closed',
  regexOpen: 'A regular expression is not closed',
  unexpected: "An unexpected '{text}'",
  bracketOpen: "A '{text}' is not closed",
  typeMissing: 'A type is missing',
  noEnums: 'Enums are not supported in scripts: use an object',
  noNamespaces: 'Namespaces are not supported in scripts: use modules',
  noDecorators: 'Decorators are not supported in scripts',
  noImportEquals: '`import x = ...` is not supported in scripts: use `import x from`',
  noExportEquals: '`export =` is not supported in scripts: use `export default`',
  noExportNamespace: '`export as namespace` is not supported in scripts',
  noExportImport: '`export import` is not supported in scripts',
  typeAliasOpen: 'A type alias is not complete',
  interfaceOpen: 'An interface is not complete',
  interfaceNoBody: 'An interface has no body',
  noAngleCast: '`<Type>value` is not supported in scripts: use `value as Type`',
  typeParametersOpen: 'Type parameters are not closed',
  noParameterProperties: 'Parameter properties are not supported in scripts: assign the fields in the constructor',
  classNoBody: 'A class has no body',
  // Linking scripts (link.ts).
  importCycle: 'imports form a cycle: {chain}',
  noScriptAt: 'there is no script {path}',
  noScript: 'there is no such script',
  relativeImport: "scripts can only import other scripts, by a relative path ('./lib.ts'), not '{name}'",
  outsideScripts: "'{name}' is outside {folder}/",
  notAScript: 'a script is a .ts or .js file in {folder}/',
  // Running one (host.ts, fetch.ts).
  networkHosts: '`network` lists host names, like api.example.com',
  tookTooLong: '{path} took longer than {seconds} seconds',
  askedWhileRunning: '{path} asked for more while it ran',
  askedBeforeStart: 'asked before it started',
  finishedBeforeStart: 'finished before it started',
  tooManyRequests: '{path} asked for more than {count} things at once',
  resultTooLarge: '{path} sent back more than the {mb} MB a run may',
  unreachable: '{host} could not be reached ({error}); a site must allow requests from other pages (CORS) for scripts in the app to use it',
  // In the sandbox (runtime.ts, through RUNTIME_MESSAGES).
  noClock: 'A producer cannot read the clock: use `today`, which the app gives it',
  noRandomIds: 'A producer cannot make random ids: its block must show the same for the same files',
  plainMeta: '`meta` must be plain data',
  defaultExport: 'A script exports a function as its default: `export default async function (api) { ... }`',
  alreadyThere: '{path} is already there',
};

export type ScriptMessageKey = keyof typeof SCRIPT_MESSAGES;
export type ScriptMessages = Record<ScriptMessageKey, string>;

/** The ones the sandbox's runtime says, handed to it with each run. */
export const RUNTIME_MESSAGES = ['noClock', 'noRandomIds', 'plainMeta', 'defaultExport', 'alreadyThere'] as const satisfies readonly ScriptMessageKey[];

let messages: ScriptMessages = SCRIPT_MESSAGES;

/** The person's language: every message from now on (the app sets it once its strings are loaded). */
export function setScriptMessages(next: ScriptMessages): void {
  messages = next;
}

/** A message, `{name}` filled from `params`. */
export function say(key: ScriptMessageKey, params: Record<string, string | number> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** What the runtime is given: the messages it says, in the person's language. */
export const runtimeMessages = (): Partial<ScriptMessages> => Object.fromEntries(RUNTIME_MESSAGES.map((key) => [key, messages[key]]));
