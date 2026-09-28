// OOXML units and conversions.

/** Twentieths of a point: page geometry, indents, spacing, table widths. */
export const TWIPS_PER_POINT = 20;
/** English Metric Units: drawing sizes. */
export const EMU_PER_POINT = 12700;
export const EMU_PER_INCH = 914400;
export const POINTS_PER_INCH = 72;

export const twipsToPoints = (twips: number) => twips / TWIPS_PER_POINT;
export const pointsToTwips = (points: number) => Math.round(points * TWIPS_PER_POINT);
/** Font sizes are stored in half-points. */
export const halfPointsToPoints = (halfPoints: number) => halfPoints / 2;
export const pointsToHalfPoints = (points: number) => Math.round(points * 2);
/** Border widths are stored in eighths of a point. */
export const eighthsToPoints = (eighths: number) => eighths / 8;
export const emuToPoints = (emu: number) => emu / EMU_PER_POINT;
export const pointsToEmu = (points: number) => Math.round(points * EMU_PER_POINT);

export type Unit = 'twips' | 'halfPoints' | 'eighths' | 'emu' | 'points' | 'number';

const PER_POINT: Record<Unit, number> = { twips: 20, halfPoints: 2, eighths: 8, emu: 12700, points: 1, number: 1 };
const UNIT_POINTS: Record<string, number> = { pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, pi: 12 };

/**
 * Parses a numeric attribute. Transitional OOXML stores plain numbers in the field's unit;
 * Strict may use universal measures ("12pt", "2.5cm"), converted here to the field's unit.
 */
export function parseMeasure(value: string, unit: Unit): number | undefined {
  const n = Number(value);
  if (value !== '' && !Number.isNaN(n)) return n;
  const match = /^(-?[0-9.]+)(pt|in|cm|mm|pc|pi)$/.exec(value.trim());
  if (!match) return undefined;
  return Math.round(Number(match[1]) * UNIT_POINTS[match[2]] * PER_POINT[unit]);
}
