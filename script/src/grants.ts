// What a person allowed a script on this device (docs/live-blocks.md §8, *Permissions and trust*), and whether that covers
// what it asks for now. Small and static: the app checks grants without loading the runner.

import { within } from './host.ts';
import type { ScriptMeta } from './host.ts';

/** What a person allowed a script on this device: the folders it may read and change, and its trigger. */
export interface ScriptGrant {
  reads: string[];
  writes: string[];
  /** Its trigger when allowed, as text (`daily 06:00`); '' for none. */
  trigger: string;
  /** The sites it may fetch from (an action). */
  network?: string[];
}

/** Where grants are kept (per device, never synced). */
export interface GrantStore {
  get(path: string): ScriptGrant | null;
  set(path: string, grant: ScriptGrant | null): void;
}

/** A trigger as text, to compare what was allowed with what is asked. */
export const triggerText = (meta: ScriptMeta): string => {
  const t = meta.trigger;
  if (!t) return '';
  return [t.daily && `daily ${t.daily}`, t.weekly && `weekly ${t.weekly}`, t.changed !== undefined && `changed ${t.changed || '/'}`].filter(Boolean).join(', ');
};

/** The grant that allows exactly what a script asks for. */
export const grantOf = (meta: ScriptMeta): ScriptGrant => ({ reads: meta.reads, writes: meta.writes, trigger: triggerText(meta), ...(meta.network && { network: meta.network }) });

/** Whether a grant covers everything a script asks for now (asking for more asks again). */
export const covers = (grant: ScriptGrant | null, meta: ScriptMeta): boolean =>
  !!grant &&
  meta.reads.every((f) => within(f, grant.reads)) &&
  meta.writes.every((f) => within(f, grant.writes)) &&
  (meta.network ?? []).every((site) => grant.network?.includes(site)) &&
  (!meta.trigger || triggerText(meta) === grant.trigger);

/** A person's answer to "may it run?": once, always (kept), or no. */
export type ScriptAnswer = 'once' | 'always' | null;

