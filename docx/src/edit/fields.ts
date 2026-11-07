// SPDX-License-Identifier: MIT
// Building fields (PAGE, NUMPAGES...) as the runs a reader makes of them: begin, instruction, separate, the shown
// result, end. The three field characters are one shape wherever they are made (reading ODF, importing a PDF).

import type { Inline, Paragraph, RunContent } from '../model/types.ts';

/** The begin, separate or end of a field (a `w:fldChar`). */
export function fieldChar(type: 'begin' | 'separate' | 'end'): RunContent {
  return { kind: 'fieldChar', type, xml: { name: 'w:fldChar', attrs: { 'w:fldCharType': type }, children: [] } };
}

/** The run contents of a field with its instruction (`PAGE`) and what it shows now, between the field characters. */
export function fieldContents(instruction: string, shown: RunContent[]): RunContent[] {
  return [fieldChar('begin'), { kind: 'instrText', text: ` ${instruction} ` }, fieldChar('separate'), ...shown, fieldChar('end')];
}

const fieldName = (instruction: string): string => instruction.trim().split(/\s+/)[0]?.toUpperCase() ?? '';

/** A paragraph holding nothing but the current page's number, aligned as asked. */
export function pageNumberParagraph(justification: string): Paragraph {
  return { kind: 'paragraph', properties: { justification }, children: [{ kind: 'run', properties: {}, content: fieldContents('PAGE', [{ kind: 'text', text: '1' }]), attrs: {} }], attrs: {} };
}

/** Whether a paragraph has a PAGE field. */
export function hasPageField(paragraph: Paragraph): boolean {
  return withoutPageFields(paragraph).found;
}

/** A paragraph with its PAGE fields taken out (as a simple field or as the runs of a complex one), and whether it had any. */
export function withoutPageFields(paragraph: Paragraph): { found: boolean; paragraph: Paragraph } {
  // A complex field can run over several runs, and only its whole instruction says what it is, so first find what is to go.
  const drop = new Set<RunContent>();
  const open: { instruction: string; items: RunContent[]; separated: boolean }[] = [];
  let found = false;
  const scan = (inlines: readonly Inline[]) => {
    for (const inline of inlines) {
      if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind === 'fieldChar' && item.type === 'begin') open.push({ instruction: '', items: [], separated: false });
          for (const field of open) field.items.push(item);
          const field = open[open.length - 1];
          if (!field) continue;
          if (item.kind === 'instrText' && !field.separated) field.instruction += item.text;
          else if (item.kind === 'fieldChar' && item.type === 'separate') field.separated = true;
          else if (item.kind === 'fieldChar' && item.type === 'end') {
            open.pop();
            if (fieldName(field.instruction) === 'PAGE') {
              found = true;
              for (const part of field.items) drop.add(part);
            }
          }
        }
      } else if (inline.kind === 'wrapper' && inline.shell.name === 'w:fldSimple') {
        if (fieldName(inline.shell.attrs['w:instr'] ?? '') === 'PAGE') found = true;
      } else if (inline.kind !== 'raw') scan(inline.children);
    }
  };
  scan(paragraph.children);
  if (!found) return { found, paragraph };
  const rebuild = (inlines: readonly Inline[]): Inline[] => {
    const out: Inline[] = [];
    for (const inline of inlines) {
      if (inline.kind === 'run') {
        const content = inline.content.filter((item) => !drop.has(item));
        if (content.length || !inline.content.length) out.push({ ...inline, content });
      } else if (inline.kind === 'wrapper' && inline.shell.name === 'w:fldSimple' && fieldName(inline.shell.attrs['w:instr'] ?? '') === 'PAGE') continue;
      else if (inline.kind === 'raw') out.push(inline);
      else out.push({ ...inline, children: rebuild(inline.children) });
    }
    return out;
  };
  return { found, paragraph: { ...paragraph, children: rebuild(paragraph.children) } };
}
