// The steps of a chart's value axis: shared by a spreadsheet's charts (sheet/charts/scene.ts) and the word history's
// (ui/progressChart.ts), so their axes are marked alike.

/** Round steps (1, 2, 5 times a power of ten) from min to max, about `count` of them. */
export function niceScale(min: number, max: number, count: number): { min: number; max: number; step: number } {
  if (!(max > min)) {
    max = min + (min === 0 ? 1 : Math.abs(min));
  }
  const rough = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(rough));
  // The smallest round step that doesn't make many more steps than asked for.
  const step = [0.5, 1, 2, 5, 10].map((m) => m * power).find((s) => (max - min) / s <= Math.max(1, count) * 1.4) ?? power * 10;
  return { min: Math.floor(min / step + 1e-9) * step, max: Math.ceil(max / step - 1e-9) * step, step };
}
