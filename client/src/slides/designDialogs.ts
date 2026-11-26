// Slide › Background and Slide › Theme (docs/slides.md, M5): the dialogs that ask how a deck should look. They are made of
// the format dialogs' shared parts (ui/formatDialogs/parts.ts) and only answer; the editor (view.ts) makes the change.

import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { h, segmented } from '../ui/dom.ts';
import { listBox } from '../ui/listBox.ts';
import { choice, colorField, field, showForm } from '../ui/formatDialogs/parts.ts';
import { COLOR_SCHEMES, FONT_PAIRS, type BackgroundSpec, type ColorScheme, type FontPair, type SchemeName } from './design.ts';
import './design.css';

// ---- Background --------------------------------------------------------------------------------------------------------

export interface BackgroundAnswer {
  /** `apply`: the slide in hand (or the master or layout, in master view); `all`: every slide; `reset`: back to what it inherits. */
  scope: 'apply' | 'all' | 'reset';
  spec: BackgroundSpec | null;
  /** A picture picked in the dialog, to add to the deck. */
  picture?: { bytes: Uint8Array; name: string };
}

const ANGLES: readonly (readonly [string, MessageKey])[] = [
  ['90', 'slides.background.down'],
  ['0', 'slides.background.across'],
  ['45', 'slides.background.diagonalDown'],
  ['315', 'slides.background.diagonalUp'],
];

/** Asks for a background. `current` is the page's own (null when it inherits); `pickImage` asks for a picture file. */
export function showBackgroundDialog(current: BackgroundSpec | null, fallback: string, options: { canReset: boolean; allLabel: string }, pickImage: () => Promise<File | null>): Promise<BackgroundAnswer | undefined> {
  type Kind = BackgroundSpec['kind'];
  let kind: Kind = current?.kind ?? 'solid';
  let picture: { bytes: Uint8Array; name: string; url: string } | null = null;
  const solid = colorField(t('slides.background.color'), t('slides.noColor'), current?.kind === 'solid' ? current.color : fallback, () => paint());
  const from = colorField(t('slides.background.from'), t('slides.noColor'), current?.kind === 'gradient' ? current.from : fallback, () => paint());
  const to = colorField(t('slides.background.to'), t('slides.noColor'), current?.kind === 'gradient' ? current.to : '#1F3864', () => paint());
  const angle = choice(
    t('slides.background.direction'),
    ANGLES.map(([v, key]) => [v, t(key)]),
    current?.kind === 'gradient' ? String(Math.round(current.angle)) : '90',
    () => paint(),
  );
  const pictureName = h('span', { class: 'wm-slides-bg-file', text: t('slides.background.noPicture') });
  const choose = h('button', { class: 'wm-button', text: t('slides.background.choosePicture'), attrs: { type: 'button' } });
  choose.addEventListener('click', async () => {
    const file = await pickImage();
    if (!file) return;
    if (picture) URL.revokeObjectURL(picture.url);
    picture = { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, url: URL.createObjectURL(file) };
    pictureName.textContent = file.name;
    paint();
  });

  const solidPane = h('div', { class: 'wm-fd-columns' }, field(t('slides.background.color'), solid.el));
  const gradientPane = h('div', {}, h('div', { class: 'wm-fd-columns' }, field(t('slides.background.from'), from.el), field(t('slides.background.to'), to.el)), field(t('slides.background.direction'), angle.el));
  const picturePane = h('div', { class: 'wm-fd-row' }, choose, pictureName);
  const panes: Record<Kind, HTMLElement> = { solid: solidPane, gradient: gradientPane, picture: picturePane };
  const kinds = segmented<Kind>(
    t('slides.background.fill'),
    [
      { value: 'solid', text: t('slides.background.solid') },
      { value: 'gradient', text: t('slides.background.gradient') },
      { value: 'picture', text: t('slides.background.picture') },
    ],
    (value) => {
      kind = value;
      paint();
    },
  );
  const sample = h('div', { class: 'wm-fd-sample wm-slides-bg-sample', attrs: { 'aria-hidden': 'true' } });

  const spec = (): BackgroundSpec | null => {
    if (kind === 'solid') return solid.value ? { kind: 'solid', color: solid.value } : null;
    if (kind === 'gradient') return from.value && to.value ? { kind: 'gradient', from: from.value, to: to.value, angle: Number(angle.value) || 0 } : null;
    return picture ? { kind: 'picture', media: '' } : null;
  };
  const paint = () => {
    kinds.set(kind);
    for (const [k, pane] of Object.entries(panes)) pane.hidden = k !== kind;
    const s = spec();
    const style = sample.style;
    style.background = '';
    if (s?.kind === 'solid') style.background = s.color;
    else if (s?.kind === 'gradient') style.background = `linear-gradient(${(s.angle + 90) % 360}deg, ${s.from}, ${s.to})`;
    else if (s?.kind === 'picture' && picture) style.background = `center / cover no-repeat url("${picture.url}")`;
  };
  paint();

  const answer = (scope: BackgroundAnswer['scope'], message: HTMLElement): BackgroundAnswer | null => {
    if (scope === 'reset') return { scope, spec: null };
    const s = spec();
    if (!s) {
      message.textContent = kind === 'picture' ? t('slides.background.needPicture') : t('slides.background.needColor');
      return null;
    }
    return { scope, spec: s, ...(picture && s.kind === 'picture' && { picture: { bytes: picture.bytes, name: picture.name } }) };
  };
  const all = h('button', { class: 'wm-button', text: options.allLabel, attrs: { type: 'button' } });
  const reset = h('button', { class: 'wm-button', text: t('slides.background.reset'), attrs: { type: 'button' } });
  reset.hidden = !options.canReset;
  const message = (): HTMLElement => all.closest('dialog')!.querySelector<HTMLElement>('.wm-find-message')!;
  return showForm<BackgroundAnswer>(
    {
      title: t('slides.background.title'),
      className: 'wm-fd-list wm-slides-design',
      body: [h('label', { text: t('slides.background.fill') }), kinds.el, solidPane, gradientPane, picturePane, sample],
      read: (m) => answer('apply', m),
      first: () => kinds.el.querySelector<HTMLElement>('[tabindex="0"]') ?? kinds.el,
      left: [all, reset],
      okText: t('slides.background.apply'),
    },
    (finish) => {
      all.addEventListener('click', () => {
        const a = answer('all', message());
        if (a) finish(a);
      });
      reset.addEventListener('click', () => finish({ scope: 'reset', spec: null }));
    },
  ).finally(() => {
    if (picture) URL.revokeObjectURL(picture.url);
  });
}

// ---- Theme ---------------------------------------------------------------------------------------------------------------

export interface ThemeAnswer {
  colors: ColorScheme;
  fonts: FontPair;
  dark: boolean;
}

/** The colours a scheme is shown by: its text and background colours and its six accents. */
const SHOWN: readonly SchemeName[] = ['dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

const schemeName = (s: ColorScheme): string => (s.id.startsWith('file:') || s.id === 'current' ? (s.label ?? s.name) : t(`slides.theme.scheme.${s.id}` as MessageKey));
const fontName = (f: FontPair): string => {
  const pair = f.major === f.minor ? f.major : t('slides.theme.fontPairPlain', { major: f.major, minor: f.minor });
  return f.id.startsWith('file:') || f.id === 'current' ? t('slides.theme.fontPair', { name: f.label ?? f.name, pair }) : pair;
};

/**
 * Asks for a theme: a colour scheme, a font pair, and whether pages are dark. `current` is the deck's now (offered first when
 * it is not one of the built-in ones); `readOther` reads another deck's or theme file's, for "From Presentation".
 */
export function showThemeDialog(current: { colors: Record<SchemeName, string>; major: string; minor: string; dark: boolean; name: string }, pickDeck: () => Promise<File | null>, readOther: (file: File) => Promise<{ colors: ColorScheme; fonts: FontPair } | null>): Promise<ThemeAnswer | undefined> {
  const same = (a: Record<SchemeName, string>, b: Record<SchemeName, string>): boolean => SHOWN.every((n) => a[n].toUpperCase() === b[n].toUpperCase());
  const schemes: ColorScheme[] = [...COLOR_SCHEMES];
  const fonts: FontPair[] = [...FONT_PAIRS];
  if (!schemes.some((s) => same(s.colors, current.colors))) schemes.unshift({ id: 'current', name: current.name, label: t('slides.theme.current', { name: current.name }), colors: current.colors });
  if (!fonts.some((f) => f.major === current.major && f.minor === current.minor)) fonts.unshift({ id: 'current', name: current.name, label: t('slides.theme.current', { name: current.name }), major: current.major, minor: current.minor });

  const swatches = h('div', { class: 'wm-slides-swatches', attrs: { 'aria-hidden': 'true' } });
  const fontSample = h('div', { class: 'wm-fd-sample wm-slides-font-sample', attrs: { 'aria-hidden': 'true' } });
  const heading = h('div', { class: 'wm-slides-font-heading', text: t('slides.theme.sampleHeading') });
  const body = h('div', { class: 'wm-slides-font-body', text: t('slides.theme.sampleBody') });
  fontSample.append(heading, body);
  const colorList = listBox(t('slides.theme.colors'), { rows: 6, onPick: () => paint() });
  const fontList = listBox(t('slides.theme.fonts'), { rows: 6, onPick: () => paint() });
  let dark = current.dark;
  const pages = segmented<'light' | 'dark'>(
    t('slides.theme.pages'),
    [
      { value: 'light', text: t('slides.theme.light') },
      { value: 'dark', text: t('slides.theme.dark') },
    ],
    (value) => {
      dark = value === 'dark';
      paint();
    },
  );
  const fill = (pickScheme: number, pickFont: number) => {
    colorList.set(schemes.map(schemeName));
    fontList.set(fonts.map(fontName));
    colorList.pick(pickScheme);
    fontList.pick(pickFont);
    paint();
  };
  const paint = () => {
    const s = schemes[colorList.index] ?? schemes[0];
    swatches.replaceChildren(...SHOWN.map((n) => h('span', { class: 'wm-slides-swatch', attrs: { style: `background:#${s.colors[n]}` } })));
    const f = fonts[fontList.index] ?? fonts[0];
    heading.style.fontFamily = `${JSON.stringify(f.major)}, system-ui`;
    body.style.fontFamily = `${JSON.stringify(f.minor)}, system-ui`;
    fontSample.style.background = `#${dark ? s.colors.dk1 : s.colors.lt1}`;
    fontSample.style.color = `#${dark ? s.colors.lt1 : s.colors.dk1}`;
    heading.style.color = `#${dark ? s.colors.lt2 : s.colors.dk2}`;
    pages.set(dark ? 'dark' : 'light');
  };
  fill(Math.max(0, schemes.findIndex((s) => same(s.colors, current.colors))), Math.max(0, fonts.findIndex((f) => f.major === current.major && f.minor === current.minor)));

  const fromFile = h('button', { class: 'wm-button', text: t('slides.theme.fromFile'), attrs: { type: 'button' } });
  fromFile.addEventListener('click', async () => {
    const message = fromFile.closest('dialog')?.querySelector<HTMLElement>('.wm-find-message');
    const file = await pickDeck();
    if (!file) return;
    const found = await readOther(file).catch(() => null);
    if (!found) {
      if (message) message.textContent = t('slides.theme.noTheme', { name: file.name });
      return;
    }
    schemes.unshift({ ...found.colors, label: t('slides.theme.fromName', { name: found.colors.name, file: file.name }) });
    fonts.unshift({ ...found.fonts, label: t('slides.theme.fromName', { name: found.fonts.name, file: file.name }) });
    fill(0, 0);
    colorList.focus();
  });

  return showForm<ThemeAnswer>({
    title: t('slides.theme.title'),
    className: 'wm-fd-list wm-slides-design',
    body: [
      h('div', { class: 'wm-fd-columns' }, h('div', {}, h('label', { text: t('slides.theme.colors') }), colorList.el, swatches), h('div', {}, h('label', { text: t('slides.theme.fonts') }), fontList.el, fontSample)),
      field(t('slides.theme.pages'), pages.el),
    ],
    read: () => ({ colors: schemes[colorList.index] ?? schemes[0], fonts: fonts[fontList.index] ?? fonts[0], dark }),
    first: () => colorList.el,
    left: [fromFile],
    okText: t('slides.background.apply'),
  });
}
