// SPDX-License-Identifier: MIT
// Building fields (PAGE, NUMPAGES...) as the runs a reader makes of them: begin, instruction, separate, the shown
// result, end. The three field characters are one shape wherever they are made (reading ODF, importing a PDF).

import type { RunContent } from '../model/types.ts';

/** The begin, separate or end of a field (a `w:fldChar`). */
export function fieldChar(type: 'begin' | 'separate' | 'end'): RunContent {
  return { kind: 'fieldChar', type, xml: { name: 'w:fldChar', attrs: { 'w:fldCharType': type }, children: [] } };
}

/** The run contents of a field with its instruction (`PAGE`) and what it shows now, between the field characters. */
export function fieldContents(instruction: string, shown: RunContent[]): RunContent[] {
  return [fieldChar('begin'), { kind: 'instrText', text: ` ${instruction} ` }, fieldChar('separate'), ...shown, fieldChar('end')];
}
