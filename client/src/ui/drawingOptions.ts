// Tools ▸ Options ▸ Drawing: how the vector editor behaves, kept on this device and in the account (see
// settingsSync.ts). The editor reads these as it goes, so a change applies to the next thing drawn.

export type Smoothing = 'off' | 'low' | 'medium' | 'high';

export const SMOOTHING_LEVELS: readonly Smoothing[] = ['off', 'low', 'medium', 'high'];

/** How far, in screen pixels, a pencil stroke's path may stray from the hand at each level. */
const TOLERANCE: Record<Smoothing, number> = { off: 0.4, low: 1.25, medium: 2.5, high: 5 };

export const SELECT_AFTER_PENCIL_KEY = 'vector.selectAfterPencil';
export const RETURN_TO_SELECT_KEY = 'vector.returnToSelect';
export const PENCIL_SMOOTHING_KEY = 'vector.pencilSmoothing';
export const PEN_PRESSURE_KEY = 'vector.penPressure';
// The guides' own switches are about the work in hand, so they stay on this device (not in SYNCED_KEYS).
export const SHOW_GUIDES_KEY = 'vector.showGuides';
export const LOCK_GUIDES_KEY = 'vector.lockGuides';
export const NUDGE_SIZE_KEY = 'vector.nudgeSize';
export const NUDGE_STRENGTH_KEY = 'vector.nudgeStrength';

/** The Nudge brush's radius, in screen pixels: its range and its starting size. */
export const NUDGE_SIZE_MIN = 8;
export const NUDGE_SIZE_MAX = 200;
export const NUDGE_SIZE_DEFAULT = 36;
/** How much of the drag the Nudge brush passes on to the lines, in percent. */
export const NUDGE_STRENGTH_MIN = 10;
export const NUDGE_STRENGTH_MAX = 100;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice lasts for this session only.
  }
};

let selectAfterPencil = read(SELECT_AFTER_PENCIL_KEY) !== 'off';
let returnToSelect = read(RETURN_TO_SELECT_KEY) !== 'off';
let smoothing: Smoothing = parseSmoothing(read(PENCIL_SMOOTHING_KEY));
let penPressure = read(PEN_PRESSURE_KEY) !== 'off';

let showGuides = read(SHOW_GUIDES_KEY) !== 'off';
let lockGuides = read(LOCK_GUIDES_KEY) === 'on';

let nudgeRadius = parseNumber(read(NUDGE_SIZE_KEY), NUDGE_SIZE_MIN, NUDGE_SIZE_MAX, NUDGE_SIZE_DEFAULT);
let nudgePercent = parseNumber(read(NUDGE_STRENGTH_KEY), NUDGE_STRENGTH_MIN, NUDGE_STRENGTH_MAX, NUDGE_STRENGTH_MAX);

/** A stored number kept within its range; `fallback` when it is missing or not a number. */
function parseNumber(value: string | null, min: number, max: number, fallback: number): number {
  const n = value === null ? NaN : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function parseSmoothing(value: string | null): Smoothing {
  return SMOOTHING_LEVELS.find((level) => level === value) ?? 'medium';
}

const listeners = new Set<() => void>();
const changed = (): void => {
  for (const listener of listeners) listener();
};

/** A finished pencil stroke is selected (on by default); off leaves nothing selected, ready for the next stroke. */
export const selectAfterPencilOn = (): boolean => selectAfterPencil;
/** After a shape or pen path is drawn the Select tool comes back (on by default); off keeps the drawing tool. */
export const returnToSelectOn = (): boolean => returnToSelect;
/** A drawing tablet's pen draws a wider line the harder it is pressed (on by default): the Pencil in drawings, the Pen and Highlighter on pictures. */
export const penPressureOn = (): boolean => penPressure;
export const pencilSmoothing = (): Smoothing => smoothing;
/** The tolerance of the pencil's curve fit, in screen pixels. */
export const pencilTolerance = (): number => TOLERANCE[smoothing];

/** The Nudge brush's radius, in screen pixels. */
export const nudgeSize = (): number => nudgeRadius;
/** How much of the drag the Nudge brush passes on, from 0.1 to 1. */
export const nudgeStrength = (): number => nudgePercent / 100;
/** The same, in percent (what the options strip shows). */
export const nudgeStrengthPercent = (): number => nudgePercent;

export function setNudgeSize(value: number): void {
  const next = parseNumber(String(value), NUDGE_SIZE_MIN, NUDGE_SIZE_MAX, nudgeRadius);
  if (next === nudgeRadius) return;
  nudgeRadius = next;
  write(NUDGE_SIZE_KEY, String(next));
  changed();
}

export function setNudgeStrength(percent: number): void {
  const next = parseNumber(String(percent), NUDGE_STRENGTH_MIN, NUDGE_STRENGTH_MAX, nudgePercent);
  if (next === nudgePercent) return;
  nudgePercent = next;
  write(NUDGE_STRENGTH_KEY, String(next));
  changed();
}

/** The guides are drawn, and shapes snap to them (on by default); off hides them without removing them. */
export const showGuidesOn = (): boolean => showGuides;
/** The guides can't be dragged or double-clicked away (off by default). */
export const lockGuidesOn = (): boolean => lockGuides;

export function setShowGuides(value: boolean): void {
  if (value === showGuides) return;
  showGuides = value;
  write(SHOW_GUIDES_KEY, value ? 'on' : 'off');
  changed();
}

export function setLockGuides(value: boolean): void {
  if (value === lockGuides) return;
  lockGuides = value;
  write(LOCK_GUIDES_KEY, value ? 'on' : 'off');
  changed();
}

export function setSelectAfterPencil(value: boolean): void {
  if (value === selectAfterPencil) return;
  selectAfterPencil = value;
  write(SELECT_AFTER_PENCIL_KEY, value ? 'on' : 'off');
  changed();
}

export function setReturnToSelect(value: boolean): void {
  if (value === returnToSelect) return;
  returnToSelect = value;
  write(RETURN_TO_SELECT_KEY, value ? 'on' : 'off');
  changed();
}

export function setPenPressure(value: boolean): void {
  if (value === penPressure) return;
  penPressure = value;
  write(PEN_PRESSURE_KEY, value ? 'on' : 'off');
  changed();
}

export function setPencilSmoothing(value: Smoothing): void {
  if (value === smoothing) return;
  smoothing = value;
  write(PENCIL_SMOOTHING_KEY, value);
  changed();
}

/** Calls `listener` when any drawing option changes (a menu's check marks follow it). */
export function onDrawingOptions(listener: () => void): void {
  listeners.add(listener);
}
