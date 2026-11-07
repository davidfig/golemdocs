// Format › Styles: the document's styles. Apply one, make one or change one (its look comes from the Font, Paragraph, Borders and Shading and
// Tabs dialogs, which edit a style the same way they edit a selection), or delete one of your own.

import { t } from '../../i18n/index.ts';
import type { BordersChoice, DocumentInfo, FontChoice, ParagraphChoice, StyleEdit, StyleInfo, TabChoice } from '../actions.ts';
import { h } from '../dom.ts';
import { listBox } from '../listBox.ts';
import { showParagraphDialog } from '../paragraphDialog.ts';
import { dialogTitleBar, showConfirm } from '../popup.ts';
import { showBordersDialog } from './bordersDialog.ts';
import { showFontDialog } from './fontDialog.ts';
import { choice, field, paintFont, showForm } from './parts.ts';
import { showTabsDialog } from './tabsDialog.ts';

export interface StylesHost {
  fonts: readonly string[];
  apply(style: StyleInfo): void;
  /** Saves a style; the styles as they now are. */
  save(edit: StyleEdit): Promise<DocumentInfo | undefined>;
  remove(id: string): Promise<DocumentInfo | undefined>;
  defaultTabStop: number;
}

/** A few words on how a style looks. */
function describe(style: StyleInfo, all: readonly StyleInfo[]): string {
  const { font, paragraph } = style;
  const parts = [font.family ?? '', t('format.styles.points', { points: font.size ?? 11 })];
  if (font.bold) parts.push(t('format.font.bold'));
  if (font.italic) parts.push(t('format.font.italic'));
  if (font.color) parts.push(font.color);
  if (style.type === 'paragraph' && paragraph.align) parts.push(t(`format.tabs.align.${paragraph.align === 'justify' ? 'left' : paragraph.align}`));
  const based = all.find((s) => s.id === style.basedOn)?.name;
  if (based) parts.push(t('format.styles.basedOnName', { name: based }));
  return parts.filter(Boolean).join(', ');
}

/** Makes a style (`style` null) or changes one: resolves with what to save, or `undefined` on Cancel. */
function showStyleEditor(style: StyleInfo | null, all: readonly StyleInfo[], current: StyleInfo | undefined, host: StylesHost): Promise<StyleEdit | undefined> {
  const name = h('input', { class: 'wm-input', attrs: { type: 'text', maxlength: '100', autocomplete: 'off', 'aria-label': t('format.styles.name') } });
  name.value = style?.name ?? '';
  const start = style ?? current;
  const look = {
    font: { ...(start?.font ?? {}) } as FontChoice,
    paragraph: { ...(start?.paragraph ?? {}) } as ParagraphChoice,
    borders: { ...(start?.borders ?? {}) } as BordersChoice,
    tabs: [...(start?.tabs ?? [])] as TabChoice[],
  };
  const edit: Pick<StyleEdit, 'font' | 'paragraph' | 'borders' | 'tabs'> = {};
  const type = choice(t('format.styles.type'), [['paragraph', t('format.styles.typeParagraph')], ['character', t('format.styles.typeCharacter')]], style?.type ?? 'paragraph', () => paint());
  type.el.disabled = !!style;
  const options = (kind: string, self?: string) => all.filter((s) => s.type === kind && s.defined && s.id !== self).map((s) => [s.id, s.name] as const);
  const none = ['', t('format.styles.noStyle')] as const;
  const basedOn = choice(t('format.styles.basedOn'), [none, ...options('paragraph', style?.id)], style ? (style.basedOn ?? '') : (current?.type === 'paragraph' ? current.id : ''));
  const next = choice(t('format.styles.next'), [['', t('format.styles.same')], ...options('paragraph', style?.id)], style?.next ?? '');
  const sample = h('span', { text: t('format.font.sample') });
  const preview = h('div', { class: 'wm-fd-sample' }, sample);
  const paint = () => {
    paintFont(sample, look.font);
    const isParagraph = type.value === 'paragraph';
    for (const el of paragraphOnly) el.hidden = !isParagraph;
    preview.style.textAlign = look.paragraph.align === 'justify' ? 'left' : (look.paragraph.align ?? 'left');
  };
  const button = (text: string, run: () => Promise<void>) => {
    const b = h('button', { class: 'wm-button', text, attrs: { type: 'button' } });
    b.addEventListener('click', () => void run().then(paint));
    return b;
  };
  const fontButton = button(t('format.styles.font'), async () => {
    const change = await showFontDialog(look.font, host.fonts);
    if (change) {
      Object.assign(look.font, change);
      edit.font = { ...edit.font, ...change };
    }
  });
  const paragraphButton = button(t('format.styles.paragraph'), async () => {
    const change = await showParagraphDialog(look.paragraph);
    if (change) {
      const changed = Object.fromEntries(Object.entries(change).filter(([key, value]) => value !== look.paragraph[key as keyof ParagraphChoice]));
      Object.assign(look.paragraph, change);
      edit.paragraph = { ...edit.paragraph, ...changed };
    }
  });
  const bordersButton = button(t('format.styles.borders'), async () => {
    const change = await showBordersDialog(look.borders);
    if (change) {
      Object.assign(look.borders, change);
      edit.borders = { ...edit.borders, ...change };
    }
  });
  const tabsButton = button(t('format.styles.tabs'), async () => {
    const tabs = await showTabsDialog(look.tabs, host.defaultTabStop);
    if (tabs) look.tabs = edit.tabs = tabs;
  });
  const nextField = field(t('format.styles.next'), next.el);
  const paragraphOnly = [nextField, paragraphButton, bordersButton, tabsButton];
  paint();

  return showForm<StyleEdit>({
    title: t(style ? 'format.styles.modifyTitle' : 'format.styles.newTitle'),
    className: 'wm-fd-styleedit',
    body: [field(t('format.styles.name'), name), field(t('format.styles.type'), type.el), field(t('format.styles.basedOn'), basedOn.el), nextField, h('label', { text: t('format.preview') }), preview, h('div', { class: 'wm-fd-row' }, fontButton, paragraphButton, bordersButton, tabsButton)],
    first: () => name,
    read(message) {
      const text = name.value.trim();
      const clash = all.some((s) => s.id !== style?.id && s.name.toLowerCase() === text.toLowerCase());
      if (!text || clash) {
        message.textContent = t(clash ? 'format.styles.nameTaken' : 'format.styles.nameNeeded');
        return null;
      }
      const kind = type.value as StyleEdit['type'];
      const out: StyleEdit = { id: style?.id, name: text, type: kind, ...(kind === 'paragraph' ? edit : { font: edit.font }) };
      // A new style starts out looking like what it is based on, with these changes on top.
      if (basedOn.value !== (style?.basedOn ?? '') || !style) out.basedOn = basedOn.value || null;
      if (kind === 'paragraph' && next.value !== (style?.next ?? '')) out.next = next.value || null;
      return out;
    },
  });
}

/** The Styles dialog. It stays open while styles are made and changed; Apply closes it. */
export function showStylesDialog(first: DocumentInfo, host: StylesHost): Promise<void> {
  return new Promise((resolve) => {
    let info = first;
    const visible = () => info.styles;
    const list = listBox(t('format.styles.list'), {
      rows: 12,
      onPick: () => paint(),
      onChoose: () => apply.click(),
    });
    const sample = h('span', { text: t('format.font.sample') });
    const preview = h('div', { class: 'wm-fd-sample' }, sample);
    const description = h('p', { class: 'wm-hint' });
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const buttonOf = (text: string) => h('button', { class: 'wm-button', text, attrs: { type: 'button' } });
    const apply = h('button', { class: 'wm-button wm-primary', text: t('format.styles.apply'), attrs: { type: 'button' } });
    const add = buttonOf(t('format.styles.new'));
    const modify = buttonOf(t('format.styles.modify'));
    const remove = buttonOf(t('format.styles.delete'));
    const close = buttonOf(t('format.bookmark.close'));
    /** The rows, headed by kind; the picked row's style. */
    const rows = () => {
      const of = (kind: StyleInfo['type']) => visible().filter((s) => s.type === kind);
      return [of('paragraph'), of('character')] as const;
    };
    const ordered = () => rows().flat();
    const picked = (): StyleInfo | undefined => ordered()[list.index];
    const fill = (id?: string) => {
      const [paragraphs, characters] = rows();
      list.set([{ heading: t('format.styles.typeParagraph') }, ...paragraphs.map((s) => s.name), ...(characters.length ? [{ heading: t('format.styles.typeCharacter') }, ...characters.map((s) => s.name)] : [])]);
      const at = ordered().findIndex((s) => s.id === id);
      list.pick(at >= 0 ? at : 0);
      paint();
    };
    const paint = () => {
      const style = picked();
      apply.disabled = modify.disabled = !style;
      remove.disabled = !style?.custom;
      if (!style) return;
      paintFont(sample, style.font);
      preview.style.textAlign = style.paragraph.align === 'justify' ? 'left' : (style.paragraph.align ?? 'left');
      description.textContent = describe(style, visible());
      message.textContent = '';
    };
    const afterSave = (id: string | undefined, name: string) => (next: DocumentInfo | undefined) => {
      if (next) info = next;
      fill(id ?? info.styles.find((s) => s.name === name)?.id);
      list.focus();
    };
    add.addEventListener('click', () => {
      void showStyleEditor(null, visible(), picked(), host).then((edit) => {
        if (edit) return host.save(edit).then(afterSave(undefined, edit.name));
      });
    });
    modify.addEventListener('click', () => {
      const style = picked();
      if (!style) return;
      void showStyleEditor(style, visible(), style, host).then((edit) => {
        if (edit) return host.save(edit).then(afterSave(style.id, edit.name));
      });
    });
    remove.addEventListener('click', () => {
      const style = picked();
      if (!style?.custom) return;
      void showConfirm(t('format.styles.deleteTitle'), h('p', { text: t('format.styles.deleteAsk', { name: style.name }) }), t('format.styles.delete')).then((yes) => {
        if (yes) return host.remove(style.id).then(afterSave(undefined, ''));
      });
    });
    apply.addEventListener('click', () => {
      const style = picked();
      if (!style) return;
      host.apply(style);
      dialog.close();
    });
    close.addEventListener('click', () => dialog.close());
    const dialog = h(
      'dialog',
      { class: 'wm-dialog wm-fd wm-fd-styles', attrs: { 'aria-label': t('format.styles.title') } },
      dialogTitleBar(t('format.styles.title'), () => dialog.close()),
      h('div', { class: 'wm-dialog-body wm-find-body' }, h('div', { class: 'wm-fd-columns' }, list.el, h('div', { class: 'wm-page-tab' }, h('label', { text: t('format.preview') }), preview, description, message)), h('div', { class: 'wm-find-buttons' }, apply, add, modify, remove, close)),
    );
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
    fill(info.current.character ?? info.current.paragraph);
    list.focus();
  });
}
