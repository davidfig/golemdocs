// The vector editor's preferences (src/ui/drawingOptions.ts, Tools › Options › Drawing).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOLS } from '../../server/src/assistantTools.ts';
import { SYNCED_KEYS } from '../src/settingsSync.ts';
import { NUDGE_SIZE_DEFAULT, NUDGE_SIZE_KEY, NUDGE_SIZE_MAX, NUDGE_SIZE_MIN, NUDGE_STRENGTH_KEY, NUDGE_STRENGTH_MIN, nudgeSize, nudgeStrength, setNudgeSize, setNudgeStrength, PENCIL_SMOOTHING_KEY, PEN_PRESSURE_KEY, penPressureOn, setPenPressure, RETURN_TO_SELECT_KEY, SELECT_AFTER_PENCIL_KEY, SMOOTHING_LEVELS, lockGuidesOn, onDrawingOptions, pencilSmoothing, pencilTolerance, returnToSelectOn, selectAfterPencilOn, setLockGuides, setPencilSmoothing, setReturnToSelect, setSelectAfterPencil, setShowGuides, showGuidesOn, LOCK_GUIDES_KEY, SHOW_GUIDES_KEY } from '../src/ui/drawingOptions.ts';

test('the defaults are the editor’s old behavior: select the stroke, return to Select, medium smoothing', () => {
  assert.equal(selectAfterPencilOn(), true);
  assert.equal(returnToSelectOn(), true);
  assert.equal(pencilSmoothing(), 'medium');
  assert.equal(pencilTolerance(), 2.5);
  assert.equal(penPressureOn(), true);
});

test('changes are remembered and announced once', () => {
  let calls = 0;
  onDrawingOptions(() => calls++);
  setSelectAfterPencil(false);
  setSelectAfterPencil(false);
  setReturnToSelect(false);
  setPencilSmoothing('high');
  setPenPressure(false);
  setPenPressure(false);
  assert.equal(penPressureOn(), false);
  setPenPressure(true);
  calls -= 2;
  assert.equal(selectAfterPencilOn(), false);
  assert.equal(returnToSelectOn(), false);
  assert.equal(pencilSmoothing(), 'high');
  assert.equal(calls, 3);
  setSelectAfterPencil(true);
  setReturnToSelect(true);
  setPencilSmoothing('medium');
});

test('more smoothing lets the path stray further from the hand', () => {
  const tolerances = SMOOTHING_LEVELS.map((level) => {
    setPencilSmoothing(level);
    return pencilTolerance();
  });
  setPencilSmoothing('medium');
  assert.deepEqual([...tolerances].sort((a, b) => a - b), tolerances);
  assert.equal(new Set(tolerances).size, tolerances.length);
});

test('the options follow the account, and the assistant can set them', () => {
  for (const key of [SELECT_AFTER_PENCIL_KEY, RETURN_TO_SELECT_KEY, PENCIL_SMOOTHING_KEY, PEN_PRESSURE_KEY]) assert.ok(SYNCED_KEYS.includes(key), key);
  const tool = TOOLS.find((t) => t.name === 'set_drawing_options');
  assert.ok(tool);
  assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties), ['select_after_pencil', 'return_to_select', 'pencil_smoothing', 'pen_pressure', 'show_guides', 'lock_guides']);
});

test('the nudge brush starts at full strength and a middle size, and its settings stay in range', () => {
  assert.equal(nudgeSize(), NUDGE_SIZE_DEFAULT);
  assert.equal(nudgeStrength(), 1);
  setNudgeSize(5000);
  assert.equal(nudgeSize(), NUDGE_SIZE_MAX);
  setNudgeSize(1);
  assert.equal(nudgeSize(), NUDGE_SIZE_MIN);
  setNudgeStrength(0);
  assert.equal(nudgeStrength(), NUDGE_STRENGTH_MIN / 100);
  setNudgeStrength(50);
  assert.equal(nudgeStrength(), 0.5);
  setNudgeSize(NUDGE_SIZE_DEFAULT);
  setNudgeStrength(100);
});

test('the nudge brush settings follow the account', () => {
  assert.ok(SYNCED_KEYS.includes(NUDGE_SIZE_KEY));
  assert.ok(SYNCED_KEYS.includes(NUDGE_STRENGTH_KEY));
});

test('guides are shown and unlocked at first, and stay on this device', () => {
  assert.equal(showGuidesOn(), true);
  assert.equal(lockGuidesOn(), false);
  let calls = 0;
  onDrawingOptions(() => calls++);
  setShowGuides(false);
  setLockGuides(true);
  assert.equal(showGuidesOn(), false);
  assert.equal(lockGuidesOn(), true);
  assert.equal(calls, 2);
  setShowGuides(true);
  setLockGuides(false);
  for (const key of [SHOW_GUIDES_KEY, LOCK_GUIDES_KEY]) assert.ok(!SYNCED_KEYS.includes(key), key);
});
