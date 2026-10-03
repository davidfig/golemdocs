// What each toolbar contains, as data: an ordered list of item ids per toolbar. An id is a
// command id ("format.bold"), a control id ("control.font"), or SEPARATOR. The layout is
// edited with Customize Toolbars (customize.ts) and remembered in this browser.

import { t } from '../i18n/index.ts';

export const SEPARATOR = '|';

export interface ToolbarLayout {
  name: string;
  visible: boolean;
  items: string[];
}

export const DEFAULT_LAYOUT: readonly ToolbarLayout[] = [
  {
    name: 'Standard',
    visible: true,
    items: [
      'file.new',
      'file.open',
      SEPARATOR,
      'file.print',
      'file.printPreview',
      'tools.spelling',
      SEPARATOR,
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'format.painter',
      SEPARATOR,
      'edit.undo',
      'edit.redo',
      SEPARATOR,
      'insert.link',
      'insert.table',
      'insert.image',
      'insert.math',
      'format.columns',
      SEPARATOR,
      'view.formattingMarks',
      'control.zoom',
      'help.shortcuts',
    ],
  },
  {
    name: 'Formatting',
    visible: true,
    // The style box is available in Customize Toolbars, but off by default.
    items: [
      'control.font',
      'control.size',
      SEPARATOR,
      'format.bold',
      'format.italic',
      'format.underline',
      'format.strikethrough',
      'format.code',
      SEPARATOR,
      'format.align.left',
      'format.align.center',
      'format.align.right',
      'format.align.justify',
      SEPARATOR,
      'format.numbering',
      'format.bullets',
      'format.checklist',
      'format.outdent',
      'format.indent',
      SEPARATOR,
      'format.clear',
      'control.highlight',
      'control.fontColor',
    ],
  },
  // Only there for pictures: it has nothing to show for any other document, so it is left out.
  {
    name: 'Picture',
    visible: true,
    items: ['image.rotateLeft', 'image.rotateRight', 'image.flipHorizontal', 'image.flipVertical', SEPARATOR, 'image.crop', 'image.resize', 'image.adjust', SEPARATOR, 'image.autoLevels', 'image.grayscale', 'image.sepia', 'image.invert', 'image.blur', 'image.sharpen'],
  },
  // Drawing on a picture; like the Picture toolbar, only there for pictures.
  {
    name: 'Draw',
    visible: true,
    items: ['image.pen', 'image.marker', SEPARATOR, 'image.line', 'image.arrow', 'image.rectangle', 'image.ellipse', 'image.fill', SEPARATOR, 'image.text', 'image.bubble', 'image.step', 'image.pixelate', 'image.eraser', 'image.move', SEPARATOR, 'control.drawColor', 'control.drawSize'],
  },
  // The vector editor's tools and commands; only there for vector drawings.
  {
    name: 'Drawing',
    visible: true,
    items: ['vector.select', SEPARATOR, 'vector.rect', 'vector.ellipse', 'control.vectorShape', 'vector.line', 'vector.pen', 'vector.pencil', 'vector.nudge', 'vector.text', 'vector.canvas', SEPARATOR, 'control.vectorFill', 'control.vectorStroke', 'control.vectorStrokeWidth', 'control.vectorStrokeStyle', SEPARATOR, 'vector.newLayer', 'vector.newGroup', 'vector.group', 'vector.ungroup', 'vector.duplicate', 'vector.delete', SEPARATOR, 'vector.front', 'vector.forward', 'vector.backward', 'vector.back', SEPARATOR, 'vector.unite', 'vector.intersect', 'vector.subtract', 'vector.exclude', 'vector.makeClip'],
  },
];

/**
 * The phone toolbar is one row: these first, then every other button from the visible toolbars
 * (they end up behind the row's "…" button, see Toolbar.fit).
 */
export const MOBILE_PRIMARY: readonly string[] = [
  'edit.undo',
  'edit.redo',
  SEPARATOR,
  'format.bold',
  'format.italic',
  'format.underline',
  SEPARATOR,
  'format.bullets',
  'format.numbering',
  SEPARATOR,
  'insert.link',
  'insert.image',
  'insert.table',
];

/** A toolbar's name as shown (its `name` is an id, kept as saved). */
export function toolbarTitle(name: string): string {
  return name === 'Standard' ? t('menus.toolbar.standard') : name === 'Formatting' ? t('menus.toolbar.formatting') : name === 'Picture' ? t('picture.menu').replace('&', '') : name === 'Draw' ? t('picture.draw.toolbar') : name === 'Drawing' ? t('vector.toolbar') : name;
}

const STORAGE_KEY = 'word.toolbars.v1';

export function cloneLayout(layout: readonly ToolbarLayout[]): ToolbarLayout[] {
  return layout.map((bar) => ({ ...bar, items: [...bar.items] }));
}

/**
 * The saved layout, or the default. Ids that no longer exist are dropped, and toolbars added
 * since the layout was saved appear with their defaults.
 */
export function loadLayout(isValid: (id: string) => boolean): ToolbarLayout[] {
  let saved: ToolbarLayout[] | null = null;
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) saved = JSON.parse(text) as ToolbarLayout[];
  } catch {
    saved = null;
  }
  return DEFAULT_LAYOUT.map((fallback) => {
    const stored = Array.isArray(saved) ? saved.find((bar) => bar?.name === fallback.name) : undefined;
    if (!stored || !Array.isArray(stored.items)) return { ...fallback, items: [...fallback.items] };
    return {
      name: fallback.name,
      visible: stored.visible !== false,
      items: stored.items.filter((id) => typeof id === 'string' && (id === SEPARATOR || isValid(id))),
    };
  });
}

export function saveLayout(layout: readonly ToolbarLayout[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage unavailable (private window, blocked): the layout lasts for this session only.
  }
}
