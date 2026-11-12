// The dialogs scripts need (docs/live-blocks.md §8): asking whether a script may run as it asks to, picking a script to run
// by hand, and Tools › Scripts, which lists every script with what it is allowed, its state and its last runs, and turns
// any of them off.

import { t } from '../i18n/index.ts';
import type { ScriptMeta } from '../scripts/host.ts';
import type { ScriptAnswer } from '../scripts/grants.ts';
import { scriptState } from '../scripts/state.ts';
import type { ScriptRecord, ScriptRun } from '../scripts/state.ts';
import { h } from './dom.ts';
import { listBox } from './listBox.ts';
import { dialogTitleBar, showChoice } from './popup.ts';

/** A folder as a person reads it: `Books/`, or the whole vault. */
const folderName = (folder: string): string => (folder ? `${folder}/` : t('live.script.wholeVault'));

/** A trigger in words: every day at 6:00, every Monday at 6:00, when a file in Inbox/ changes. */
export function triggerWords(trigger: ScriptMeta['trigger']): string[] {
  if (!trigger) return [];
  const out: string[] = [];
  if (trigger.daily) out.push(t('live.script.daily', { time: trigger.daily }));
  if (trigger.weekly) {
    const [day, time] = trigger.weekly.split(/\s+/);
    out.push(t('live.script.weekly', { day: weekdayName(day), time }));
  }
  if (trigger.changed !== undefined) out.push(t('live.script.changed', { folder: folderName(trigger.changed) }));
  return out;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function weekdayName(day: string): string {
  const index = DAYS.indexOf(day.slice(0, 3).toLowerCase());
  // A Sunday in January 2023 is the 1st: the weekday's name in the app's language.
  return index < 0 ? day : new Date(2023, 0, 1 + index).toLocaleDateString(undefined, { weekday: 'long' });
}

/** What a script asks for, one line each. */
export function grantLines(meta: Pick<ScriptMeta, 'reads' | 'writes' | 'trigger' | 'network'>): string[] {
  const lines = [
    ...meta.reads.map((f) => t('live.script.reads', { folder: folderName(f) })),
    ...meta.writes.map((f) => t('live.script.writes', { folder: folderName(f) })),
    ...(meta.network ?? []).map((site) => t('live.script.network', { site })),
    ...triggerWords(meta.trigger),
  ];
  return lines.length ? lines : [t('live.script.nothing')];
}

/** Asks whether a script may run as it asks to: once, always on this device, or not. */
export function askToRun(path: string, meta: ScriptMeta): Promise<ScriptAnswer> {
  const body = h(
    'div',
    {},
    h('p', { text: t('live.script.askWants', { name: meta.name, path }) }),
    h('ul', { class: 'wm-script-grant' }, ...grantLines(meta).map((line) => h('li', { text: line }))),
    h('p', { class: 'wm-hint', text: meta.network?.length ? t('live.script.askHintNetwork') : t('live.script.askHint') }),
  );
  return showChoice<'once' | 'always'>(t('live.script.askTitle'), body, [
    { label: t('live.script.allowOnce'), value: 'once' },
    { label: t('live.script.allowAlways'), value: 'always', primary: true },
  ]);
}

/** Picks a script to run by hand; null when none is picked. */
export function pickScript(scripts: readonly { path: string; name: string }[]): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'wm-dialog', attrs: { 'aria-label': t('live.script.runTitle') } });
    let chosen: string | null = null;
    const choose = () => {
      chosen = scripts[list.index]?.path ?? null;
      dialog.close();
    };
    const list = listBox(t('live.script.runTitle'), { rows: 8, onChoose: choose });
    list.set(scripts.length ? scripts.map((s) => `${s.name} (${s.path})`) : [{ note: t('live.script.none') }]);
    const cancel = h('button', { class: 'wm-button', text: t('menus.dialog.cancel') });
    const run = h('button', { class: 'wm-button wm-primary', text: t('live.script.run') });
    run.disabled = !scripts.length;
    cancel.addEventListener('click', () => dialog.close());
    run.addEventListener('click', choose);
    dialog.append(dialogTitleBar(t('live.script.runTitle'), () => dialog.close()), h('div', { class: 'wm-dialog-body wm-scripts' }, list.el), h('div', { class: 'wm-dialog-buttons' }, cancel, run));
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(chosen);
    });
    document.body.append(dialog);
    dialog.showModal();
    list.focus();
  });
}

export interface ScriptListing {
  path: string;
  /** Its meta, or null when it could not be read (then `error` says why). */
  meta: ScriptMeta | null;
  error?: string;
}

export interface ScriptsDialogHost {
  /** Every script in the vault, with its meta. */
  scripts(): Promise<ScriptListing[]>;
  /** Runs an action by hand. */
  run(path: string): Promise<void>;
  /** Undoes a run from the log. */
  undo(run: ScriptRun): Promise<void>;
  /** Whether a run can still be undone from what this page kept. */
  canUndo(run: ScriptRun): boolean;
  /** Puts a block in the open document: a producer's result, or a button running an action. Missing where it can't. */
  insert?(source: string): void;
}

/** What a script goes into a document as: its result (a producer), or a button that runs it (an action). */
export const blockSource = (path: string, meta: ScriptMeta): string => (meta.writes.length || meta.trigger ? `@run:${path}` : path);

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

function stateText(record: ScriptRecord): string {
  if (record.off) return t('live.script.stateOff');
  if (record.paused) return t('live.script.statePaused', { count: record.failures ?? 0 });
  return record.grant ? t('live.script.stateAllowed') : t('live.script.stateNotAllowed');
}

/** Tools › Scripts. */
export async function showScriptsDialog(host: ScriptsDialogHost): Promise<void> {
  const dialog = h('dialog', { class: 'wm-dialog wm-scripts-dialog', attrs: { 'aria-label': t('live.script.title') } });
  const message = h('div', { class: 'wm-find-message', attrs: { role: 'status' } });
  const details = h('div', { class: 'wm-script-details' });
  let listing: ScriptListing[] = [];
  const scripts = listBox(t('live.script.title'), { rows: 6, onPick: () => showDetails() });
  const runs = listBox(t('live.script.log'), { rows: 5, onPick: () => showDetails() });
  let log: ScriptRun[] = [];

  const button = (label: string, act: () => void | Promise<void>) => {
    const b = h('button', { class: 'wm-button', text: label });
    b.addEventListener('click', () => {
      message.textContent = '';
      void Promise.resolve(act())
        .catch((e: unknown) => (message.textContent = (e as Error).message))
        .finally(() => refresh(true));
    });
    return b;
  };
  const picked = () => listing[scripts.index] ?? null;
  const runNow = button(t('live.script.run'), async () => {
    const p = picked();
    if (p) await host.run(p.path);
  });
  const toggle = button(t('live.script.turnOff'), () => {
    const p = picked();
    if (p) scriptState.update(p.path, (r) => (r.off || r.paused ? { ...r, off: false, paused: false, failures: 0 } : { ...r, off: true }));
  });
  const forget = button(t('live.script.forget'), () => {
    const p = picked();
    if (p) scriptState.grants.set(p.path, null);
  });
  const insert = button(t('live.script.insert'), () => {
    const p = picked();
    if (p?.meta && host.insert) {
      dialog.close();
      host.insert(blockSource(p.path, p.meta));
    }
  });
  insert.hidden = !host.insert;
  const undo = button(t('live.script.undo'), async () => {
    const run = log[runs.index];
    if (run) await host.undo(run);
  });

  function showDetails(): void {
    const p = picked();
    details.replaceChildren();
    if (p) {
      const record = scriptState.record(p.path);
      details.append(h('p', { text: p.meta ? `${p.meta.name}: ${stateText(record)}` : (p.error ?? p.path) }));
      if (p.meta) details.append(h('ul', { class: 'wm-script-grant' }, ...grantLines(p.meta).map((line) => h('li', { text: line }))));
      toggle.textContent = record.off || record.paused ? t('live.script.turnOn') : t('live.script.turnOff');
      forget.disabled = !record.grant;
      runNow.disabled = !p.meta || record.off === true || !(p.meta.writes.length || p.meta.trigger);
      insert.disabled = !p.meta;
    }
    toggle.disabled = forget.disabled && !p;
    const run = log[runs.index];
    undo.disabled = !run || !run.ok || run.undone === true || !run.changed?.length || !host.canUndo(run);
  }

  async function refresh(keep = false): Promise<void> {
    const at = scripts.index;
    const runAt = runs.index;
    if (!keep) listing = await host.scripts();
    scripts.set(listing.length ? listing.map((s) => `${s.meta?.name ?? s.path} (${s.path})`) : [{ note: t('live.script.none') }]);
    if (at > 0) scripts.pick(Math.min(at, listing.length - 1));
    log = scriptState.log();
    runs.set(
      log.length
        ? log.map((r) => `${when(r.at)}  ${r.name}: ${r.undone ? t('live.script.wasUndone') : r.ok ? (r.message ?? t('live.script.changedCount', { count: r.changed?.length ?? 0 })) : (r.message ?? '')}`)
        : [{ note: t('live.script.noRuns') }],
    );
    if (runAt > 0) runs.pick(Math.min(runAt, log.length - 1));
    showDetails();
  }

  const close = h('button', { class: 'wm-button wm-primary', text: t('menus.dialog.ok') });
  close.addEventListener('click', () => dialog.close());
  dialog.append(
    dialogTitleBar(t('live.script.title'), () => dialog.close()),
    h(
      'div',
      { class: 'wm-dialog-body wm-scripts' },
      scripts.el,
      details,
      h('div', { class: 'wm-script-buttons' }, runNow, insert, toggle, forget),
      h('label', { text: t('live.script.log') }),
      runs.el,
      h('div', { class: 'wm-script-buttons' }, undo),
      message,
    ),
    h('div', { class: 'wm-dialog-buttons' }, close),
  );
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  scripts.focus();
  await refresh();
}
