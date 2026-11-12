// Runs scripts for the app (docs/live-blocks.md §8): a producer for a live block, an action by hand or on a trigger. It
// reads the script and what it imports from the vault, links them into one program, runs it on a fresh channel (the
// sandboxed frame in the app, a Node worker in the tests), lets it go only with a grant, answers its requests from the
// vault, and turns what comes back into a block's result or the files an action changed. What each producer read is kept,
// so the keeper updates its blocks when one of those changes.
//
// Nothing here touches the DOM or the library: the app gives it a channel, its vault, where grants are kept and how to ask.

import { paragraphText, paragraphsIn, WordDocument } from '@golemdocs/docx';
import type { LiveResult } from '../live/result.ts';
import { isWdoc, readWdoc } from '../formats/wdoc.ts';
import { normalizeFolder, runOnChannel, ScriptRunError, scriptToday, seedOf } from './host.ts';
import type { RuntimeChannel, ScriptMeta } from './host.ts';
import { covers, grantOf } from './grants.ts';
import type { GrantStore, ScriptAnswer } from './grants.ts';

export type { GrantStore, ScriptAnswer, ScriptGrant } from './grants.ts';
export { covers, grantOf, triggerText } from './grants.ts';
import { isScriptPath, linkScript, ScriptError } from './link.ts';
import type { RunMode } from './runtime.ts';
import { editedFiles, ScriptRequests, scriptResult } from './vault.ts';
import type { ChangedFile, ScriptVault } from './vault.ts';

/** The app's side, as the runner needs it. */
export interface RunnerDeps {
  /** The vault: its documents, and what a sheet's range shows. */
  vault: Omit<ScriptVault, 'produce'> & { produce(address: string): Promise<LiveResult> };
  /** A fresh channel to a sandboxed worker, for one run. */
  channel(): RuntimeChannel;
  grants: GrantStore;
  /** Asks the person whether a script may run as it asks to; missing where no one can be asked. */
  ask?(path: string, meta: ScriptMeta, mode: RunMode): Promise<ScriptAnswer>;
  /** The time now (the tests set it). */
  now?(): Date;
}

export interface RunLimits {
  timeoutMs: number;
  maxResultChars: number;
}

export const PRODUCER_LIMITS: RunLimits = { timeoutMs: 5_000, maxResultChars: 2_000_000 };
export const ACTION_LIMITS: RunLimits = { timeoutMs: 30_000, maxResultChars: 5_000_000 };

export interface RunOptions {
  /** A person started it (a button, the palette, a block just pasted): it may ask. */
  interactive?: boolean;
}

/** What an action did: the files it would change, not yet stored. */
export interface ActOutcome {
  meta: ScriptMeta;
  files: ChangedFile[];
  /** What the script returned, as text (shown after a run by hand). */
  message: string | null;
}

/** A script's text from its stored bytes: the file itself, or the document the app keeps it as once edited here. */
export async function scriptText(bytes: Uint8Array): Promise<string> {
  if (!isWdoc(bytes)) return new TextDecoder().decode(bytes);
  const wdoc = await readWdoc(bytes);
  if (wdoc.delimited) return new TextDecoder().decode(wdoc.delimited);
  if (!wdoc.document) return '';
  const doc = await WordDocument.read(wdoc.document);
  return paragraphsIn(doc.body).map(paragraphText).join('\n');
}

export class ScriptRunner {
  /** What each producer's last run read, and the scripts it is made of (vault paths; a folder ends in `/`). */
  private readonly lastReads = new Map<string, string[]>();
  /** Producers whose result depends on the date. */
  readonly usesDate = new Set<string>();

  constructor(private readonly deps: RunnerDeps) {}

  /** What a producer's last run read, for the keeper. */
  reads(path: string): readonly string[] {
    return this.lastReads.get(normalizeFolder(path)) ?? [];
  }

  private async program(path: string): Promise<{ url: string; files: string[] }> {
    return linkScript(path, async (p) => {
      const file = await this.deps.vault.file(p);
      return file ? scriptText(file.bytes) : null;
    });
  }

  /** The script's meta, without running it. */
  async describe(path: string): Promise<ScriptMeta> {
    const { url } = await this.program(normalizeFolder(path));
    const outcome = await runOnChannel(this.deps.channel(), path, { mode: 'describe', program: url, today: scriptToday(this.now()), seed: 0, ...PRODUCER_LIMITS, approve: async () => true, request: async () => null });
    return outcome.meta;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Whether it may go on: its grant covers it, or the person says so now. */
  private approver(path: string, mode: RunMode, options: RunOptions) {
    return async (meta: ScriptMeta): Promise<true | string> => {
      if (mode === 'produce' && meta.writes.length) return `${meta.name} is a producer, which cannot ask to change files`;
      if (mode === 'produce' && meta.network?.length) return `${meta.name} is a producer, which cannot use the network`;
      if (covers(this.deps.grants.get(path), meta)) return true;
      if (!options.interactive || !this.deps.ask) return `${meta.name} has not been allowed on this device`;
      const answer = await this.deps.ask(path, meta, mode);
      if (!answer) return `${meta.name} was not allowed`;
      if (answer === 'always') this.deps.grants.set(path, grantOf(meta));
      return true;
    };
  }

  /** A producer's result for a live block; `chain` is the producers already running for it (a cycle is an error). */
  async produce(path: string, options: RunOptions = {}, chain: readonly string[] = []): Promise<LiveResult> {
    path = normalizeFolder(path);
    if (chain.includes(path)) return { kind: 'error', code: 'cycle' };
    let program: { url: string; files: string[] };
    try {
      program = await this.program(path);
    } catch (e) {
      if (e instanceof ScriptError && e.message === `${path}: there is no such script`) return { kind: 'error', code: 'missing', detail: path };
      return { kind: 'error', code: 'script', detail: (e as Error).message };
    }
    const vault: ScriptVault = {
      list: (folder) => this.deps.vault.list(folder),
      file: (p) => this.deps.vault.file(p),
      // Another producer's result runs in this chain; anything else is the app's.
      produce: (address) => (isScriptPath(normalizeFolder(address)) ? this.produce(address, options, [...chain, path]) : this.deps.vault.produce(address)),
    };
    const requests = new ScriptRequests(vault, 'produce');
    const today = scriptToday(this.now());
    try {
      const outcome = await runOnChannel(this.deps.channel(), path, {
        mode: 'produce',
        program: program.url,
        today,
        seed: seedOf(path),
        ...PRODUCER_LIMITS,
        approve: this.approver(path, 'produce', options),
        request: (op, args, meta) => requests.handle(op, args, meta),
      });
      if (outcome.usesDate) this.usesDate.add(path);
      else this.usesDate.delete(path);
      return scriptResult(outcome.result);
    } catch (e) {
      if (e instanceof ScriptRunError && e.code === 'denied') return { kind: 'error', code: 'notAllowed', detail: e.message };
      return { kind: 'error', code: 'script', detail: (e as Error).message };
    } finally {
      // Its block depends on what it read and what it is made of, even when it failed (fixing either updates it).
      this.lastReads.set(path, [...program.files.slice(1), ...requests.read]);
    }
  }

  /** Runs an action; the files it changed come back to be stored together (or not at all). Throws ScriptRunError or ScriptError. */
  async act(path: string, options: RunOptions = {}): Promise<ActOutcome> {
    path = normalizeFolder(path);
    const program = await this.program(path);
    const requests = new ScriptRequests({ ...this.deps.vault, produce: (address) => (isScriptPath(normalizeFolder(address)) ? this.produce(address, options) : this.deps.vault.produce(address)) }, 'act');
    const now = this.now();
    const outcome = await runOnChannel(this.deps.channel(), path, {
      mode: 'act',
      program: program.url,
      today: scriptToday(now),
      now: now.toISOString(),
      seed: seedOf(`${path}${now.toISOString()}`),
      ...ACTION_LIMITS,
      approve: this.approver(path, 'act', options),
      request: (op, args, meta) => requests.handle(op, args, meta),
    });
    const files = await editedFiles(outcome.edits, outcome.meta, this.deps.vault).catch((e: unknown) => {
      throw new ScriptRunError(`${path}: ${(e as Error).message}`, 'failed');
    });
    return { meta: outcome.meta, files, message: typeof outcome.result === 'string' && outcome.result ? outcome.result : null };
  }
}
