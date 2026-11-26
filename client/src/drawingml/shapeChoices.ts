// The shapes Insert › Shape offers where shapes are DrawingML (docs/architecture/drawingml.md): the app's one catalogue of
// shapes (vector/shapes.ts), so each is shown with the Shapes tool's picture and name, in groups, with the DrawingML preset
// it is inserted as.

import type { ShapeId } from '../vector/shapes.ts';

export interface ShapeChoice {
  id: ShapeId;
  /** The DrawingML preset geometry (`a:prstGeom prst`). */
  preset: string;
}

const choice = (id: ShapeId, preset: string = id): ShapeChoice => ({ id, preset });

/** The groups of the picker: basic shapes, symbols, lines and arrows, callouts, flowchart shapes. */
export const SHAPE_GROUPS: readonly (readonly ShapeChoice[])[] = [
  [choice('rect'), choice('roundRect'), choice('ellipse'), choice('triangle'), choice('rightTriangle', 'rtTriangle'), choice('diamond'), choice('parallelogram'), choice('trapezoid'), choice('pentagon'), choice('hexagon'), choice('octagon')],
  [choice('star', 'star5'), choice('star4'), choice('star6'), choice('heart'), choice('plus'), choice('moon'), choice('cloud'), choice('lightning', 'lightningBolt')],
  [choice('line'), choice('arrowRight', 'rightArrow'), choice('arrowLeft', 'leftArrow'), choice('arrowUp', 'upArrow'), choice('arrowDown', 'downArrow'), choice('leftRightArrow'), choice('chevron')],
  [choice('rectCallout', 'wedgeRectCallout'), choice('ovalCallout', 'wedgeEllipseCallout'), choice('bubble', 'wedgeRoundRectCallout')],
  [choice('process', 'flowChartProcess'), choice('decision', 'flowChartDecision'), choice('terminator', 'flowChartTerminator')],
];

/** Every shape the picker offers, in its order. */
export const SHAPE_CHOICES: readonly ShapeChoice[] = SHAPE_GROUPS.flat();

/** Whether a preset is drawn as a line (a connector, `p:cxnSp`), with no area and no text. */
export const isLinePreset = (preset: string): boolean => preset === 'line' || preset.endsWith('Connector1') || preset.startsWith('straightConnector');
