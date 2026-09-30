// Mapping between a paragraph's visible text (what layout lays out, list label excluded) and
// its model offsets (what edits address). They differ where content is hidden (vanished runs,
// tracked deletions, field instructions) or shown in place of the model (field results).

/** A stretch of visible text and the model positions it stands for. */
export interface SourceSpan {
  /** Visible offset of the first character. */
  visible: number;
  /** Model offset of the first position. */
  model: number;
  /** Visible length. */
  length: number;
  modelLength: number;
  /** Text copied from the model one-to-one (else an atomic item: a tab, a field result...). */
  text: boolean;
}

/** Index of the last span starting at or before `value` (by `key`), or -1. */
function lastAtOrBefore(spans: readonly SourceSpan[], value: number, key: 'visible' | 'model'): number {
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid][key] <= value) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Model offset of a visible offset. Between two spans (hidden content between them), the
 * position right after the first: text typed there continues the text before it.
 */
export function toModel(spans: readonly SourceSpan[], visible: number): number {
  if (spans.length === 0) return 0;
  // The span ending at or containing the offset; at a boundary, the earlier one.
  let i = lastAtOrBefore(spans, visible, 'visible');
  if (i > 0 && spans[i].visible === visible) i--;
  if (i < 0) return spans[0].model;
  const s = spans[i];
  const into = visible - s.visible;
  if (into >= s.length) return s.model + s.modelLength;
  if (into <= 0) return s.model;
  return s.text ? s.model + into : s.model;
}

/** Visible offset of a model offset. Positions in hidden content move to the next visible one. */
export function toVisible(spans: readonly SourceSpan[], model: number): number {
  if (spans.length === 0) return 0;
  const i = lastAtOrBefore(spans, model, 'model');
  if (i < 0) return 0;
  const s = spans[i];
  const into = model - s.model;
  if (into >= s.modelLength) {
    // After this span: at its end, or in hidden content before the next span.
    return s.visible + s.length;
  }
  if (into <= 0) return s.visible;
  return s.text ? s.visible + into : s.visible + s.length;
}

/**
 * Model offset of the character at a visible offset (for an atomic item, the item's), or -1
 * past the end. Unlike toModel, a boundary between spans belongs to the later span: this is
 * the character drawn there, not where typing would go.
 */
export function modelOfChar(spans: readonly SourceSpan[], visible: number): number {
  const i = lastAtOrBefore(spans, visible, 'visible');
  if (i < 0) return -1;
  const s = spans[i];
  const into = visible - s.visible;
  if (into >= s.length) return -1;
  return s.text ? s.model + into : s.model;
}

/** Visible length of a paragraph's text. */
export function visibleLength(spans: readonly SourceSpan[]): number {
  const last = spans.at(-1);
  return last ? last.visible + last.length : 0;
}
