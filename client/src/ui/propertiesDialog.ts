// File ▸ Properties: the title, author and other details kept with the document (Summary), and its
// dates and size (Statistics), as in Word 2003. The values live in the layout worker's document; this
// asks for them and sends back what was changed (see @golemdocs/editor setProperties).

import type { DocumentProperties } from '@golemdocs/docx';
import { getLocale, t, type MessageKey } from '../i18n/index.ts';
import type { WireCommand, WordStats } from '../layout/protocol.ts';
import { h } from './dom.ts';

const SUMMARY: { key: keyof DocumentProperties; label: MessageKey; multiline?: boolean }[] = [
  { key: 'title', label: 'properties.titleField' },
  { key: 'subject', label: 'properties.subject' },
  { key: 'author', label: 'properties.author' },
  { key: 'manager', label: 'properties.manager' },
  { key: 'company', label: 'properties.company' },
  { key: 'category', label: 'properties.category' },
  { key: 'keywords', label: 'properties.keywords' },
  { key: 'comments', label: 'properties.comments', multiline: true },
];

const COUNTS: { key: keyof Omit<WordStats, 'selection' | 'table'>; label: MessageKey }[] = [
  { key: 'pages', label: 'wordCount.pages' },
  { key: 'words', label: 'wordCount.words' },
  { key: 'charactersWithoutSpaces', label: 'wordCount.charactersWithoutSpaces' },
  { key: 'charactersWithSpaces', label: 'wordCount.charactersWithSpaces' },
  { key: 'paragraphs', label: 'wordCount.paragraphs' },
  { key: 'lines', label: 'wordCount.lines' },
];

/** A stored W3CDTF date as the reader's own date and time, or a dash. */
const showDate = (iso: string | undefined): string => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString(getLocale()) : '—';
};

export class PropertiesDialog {
  private dialog: HTMLDialogElement | null = null;
  private fields = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  private dates = new Map<string, HTMLElement>();
  private counts = new Map<string, HTMLElement>();
  private ok: HTMLButtonElement | null = null;
  /** The properties as the document has them (what the dialog started from). */
  private loaded: DocumentProperties | null = null;

  constructor(private readonly host: { send(command: WireCommand): void; focusEditor(): void }) {}

  open(): void {
    if (this.dialog) return;
    this.fields.clear();
    this.dates.clear();
    this.counts.clear();
    this.loaded = null;

    const summary = h('div', { class: 'wm-page-tab', attrs: { role: 'tabpanel' } });
    for (const { key, label, multiline } of SUMMARY) {
      const input = multiline ? h('textarea', { class: 'wm-input wm-properties-comments', attrs: { rows: '3', 'aria-label': t(label).replace(/[:：]$/, '') } }) : h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': t(label).replace(/[:：]$/, ''), autocomplete: 'off' } });
      input.disabled = true;
      this.fields.set(key, input);
      summary.append(h('label', { text: t(label) }), input);
    }

    const statistics = h('div', { class: 'wm-page-tab', attrs: { role: 'tabpanel' } });
    const table = h('table', { class: 'wm-stats' });
    const row = (label: MessageKey, cell: HTMLElement) => table.append(h('tr', {}, h('th', { text: t(label), attrs: { scope: 'row' } }), cell));
    for (const [key, label] of [['created', 'properties.created'], ['modified', 'properties.modified'], ['lastModifiedBy', 'properties.lastModifiedBy']] as const) {
      const value = h('td', { class: 'wm-stat-value', text: '…' });
      this.dates.set(key, value);
      row(label, value);
    }
    for (const { key, label } of COUNTS) {
      const value = h('td', { class: 'wm-stat-value', text: '…' });
      this.counts.set(key, value);
      row(label, value);
    }
    statistics.append(table);

    const tabs = h('div', { class: 'wm-find-tabs', attrs: { role: 'tablist' } });
    const panes: [HTMLElement, HTMLElement][] = [];
    const select = (i: number) =>
      panes.forEach(([button, pane], k) => {
        button.setAttribute('aria-selected', String(k === i));
        pane.hidden = k !== i;
      });
    ([[t('properties.tabSummary'), summary], [t('properties.tabStatistics'), statistics]] as const).forEach(([label, pane], i) => {
      const button = h('button', { class: 'wm-find-tab', text: label, attrs: { type: 'button', role: 'tab' } });
      button.addEventListener('click', () => select(i));
      tabs.append(button);
      panes.push([button, pane]);
    });
    select(0);

    const ok = h('button', { class: 'wm-button', text: t('properties.ok'), attrs: { type: 'submit' } });
    ok.disabled = true;
    this.ok = ok;
    const cancel = h('button', { class: 'wm-button', text: t('properties.cancel'), attrs: { type: 'button' } });
    const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { type: 'button', 'aria-label': t('properties.close') } });
    const form = h('form', { attrs: { method: 'dialog' } }, tabs, h('div', { class: 'wm-dialog-body wm-link-body' }, summary, statistics), h('div', { class: 'wm-dialog-buttons' }, h('span', { class: 'wm-link-actions' }, ok, cancel)));
    const dialog = h('dialog', { class: 'wm-dialog wm-link wm-pagesetup wm-properties', attrs: { 'aria-label': t('properties.title') } }, h('div', { class: 'wm-dialog-title' }, h('span', { text: t('properties.title') }), close), form);

    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.save();
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      this.dialog = null;
      this.host.focusEditor();
    });
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.showModal();
    this.host.send({ kind: 'getProperties' });
    this.host.send({ kind: 'countWords', whole: true });
  }

  /** The document's properties: fill the fields in and let them be edited. */
  reportProperties(properties: DocumentProperties): void {
    if (!this.dialog) return;
    this.loaded = properties;
    for (const { key } of SUMMARY) {
      const field = this.fields.get(key)!;
      field.value = properties[key] ?? '';
      field.disabled = false;
    }
    for (const [key, cell] of this.dates) cell.textContent = key === 'lastModifiedBy' ? (properties.lastModifiedBy ?? '—') : showDate(properties[key as 'created' | 'modified']);
    if (this.ok) this.ok.disabled = false;
    this.fields.get('title')!.focus();
  }

  /** The document's counts. */
  reportStats(stats: WordStats | null): void {
    if (!this.dialog) return;
    for (const { key } of COUNTS) this.counts.get(key)!.textContent = stats ? stats[key].toLocaleString() : '—';
  }

  /** Sends the changes, if there are any. */
  private save(): void {
    if (!this.loaded) return;
    const next: DocumentProperties = { ...this.loaded };
    for (const { key } of SUMMARY) {
      const value = this.fields.get(key)!.value.trim();
      if (value) next[key] = value;
      else delete next[key];
    }
    if (JSON.stringify(next) !== JSON.stringify(this.loaded)) this.host.send({ kind: 'setProperties', properties: next });
  }
}
