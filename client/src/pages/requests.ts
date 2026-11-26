// What a page's `golem` calls are answered with (docs/html-pages.md §3, §6). Only a page whose scripts run asks anything: an
// own page, which may read the whole vault and change documents in it, or a foreign page that may read nothing (its reads are
// refused). Reads go through the same checks and readers as a script's (scripts/vault.ts); an edit is applied as an action's
// is, through the document model, and logged as a run so Tools › Scripts can undo it.

import type { ScriptMeta } from '@golemdocs/script/host';
import type { ScriptEdit, ScriptEditOp } from '@golemdocs/script/runtime';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import type { LiveResult } from '../live/result.ts';
import { editedFiles, ScriptRequests } from '../scripts/vault.ts';
import type { ChangedFile, ScriptVault } from '../scripts/vault.ts';
import type { PageTrust } from './compose.ts';
import { resultHtml } from './embedHtml.ts';

export interface PageRequestDeps {
  vault: ScriptVault;
  /** What an embed's address shows, found as a live block in the page would find it, and the vault paths that read. */
  embed(address: string): Promise<{ result: LiveResult; paths: string[] }>;
  /** Stores an edited document (made, with its folders, when it is new). */
  store(file: ChangedFile): Promise<void>;
  /** An edit was applied: logged as a run of the page, with what undoes it. */
  logged(files: readonly ChangedFile[]): void;
}

const OPS = new Set(['append', 'prepend', 'replace', 'setField', 'appendToSection', 'replaceSection']);

/** An edit's operations as the page sent them, checked: anything else is refused. */
export function editOps(raw: unknown): ScriptEditOp[] {
  if (!Array.isArray(raw)) throw new Error(t('pages.error.badEdit'));
  return raw.map((op): ScriptEditOp => {
    const o = (op && typeof op === 'object' ? op : {}) as Record<string, unknown>;
    if (typeof o.op !== 'string' || !OPS.has(o.op)) throw new Error(t('pages.error.badEdit'));
    const text = (v: unknown) => (typeof v === 'string' ? v : String(v ?? ''));
    switch (o.op) {
      case 'setField':
        return { op: 'setField', key: text(o.key), value: o.value === null ? null : text(o.value) };
      case 'appendToSection':
      case 'replaceSection':
        return { op: o.op, heading: text(o.heading), markdown: text(o.markdown) };
      default:
        return { op: o.op as 'append' | 'prepend' | 'replace', markdown: text(o.markdown) };
    }
  });
}

/** An error result's words, as a live block says them. */
export const sayLiveError = (result: Extract<LiveResult, { kind: 'error' }>, source: string): string => t(`live.error.${result.code}` as MessageKey, { source, detail: result.detail ?? '' });

/** Answers one page's requests while it is shown; `read` records what it read, so it is told when that changes. */
export class PageRequests {
  /** The vault paths (and folders, ending in `/`) the page read. */
  readonly read = new Set<string>();
  private readonly reader: ScriptRequests;
  private readonly meta: ScriptMeta;

  constructor(
    private readonly deps: PageRequestDeps,
    readonly page: { path: string; name: string; trust: PageTrust },
  ) {
    const own = page.trust === 'own';
    this.meta = { name: page.name, reads: own ? [''] : [], writes: own ? [''] : [], trigger: null };
    this.reader = new ScriptRequests(deps.vault, 'produce');
  }

  async handle(op: string, args: unknown[]): Promise<unknown> {
    const arg = typeof args[0] === 'string' ? args[0] : '';
    switch (op) {
      case 'read':
      case 'notes':
      case 'sheet':
      case 'result': {
        if (this.page.trust !== 'own') throw new Error(t('pages.error.foreignRead', { name: this.page.name }));
        const value = await this.reader.handle(op, args, this.meta);
        for (const path of this.reader.read) this.read.add(path);
        return value;
      }
      case 'embed': {
        if (this.page.trust !== 'own') throw new Error(t('pages.error.foreignRead', { name: this.page.name }));
        const { result, paths } = await this.deps.embed(arg);
        for (const path of paths) this.read.add(path);
        return resultHtml(result, (r) => sayLiveError(r, arg));
      }
      case 'edit': {
        if (this.page.trust !== 'own') throw new Error(t('pages.error.foreignEdit', { name: this.page.name }));
        const edit: ScriptEdit = { path: arg, ops: editOps(args[1]), create: args[2] === true };
        const files = await editedFiles([edit], this.meta, this.deps.vault);
        for (const file of files) await this.deps.store(file);
        if (files.length) this.deps.logged(files);
        return files.length;
      }
    }
    throw new Error(t('scripts.vault.cannot', { op }));
  }
}
