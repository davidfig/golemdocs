// The hint under a formula being typed (as Excel's): the function the caret is inside, its arguments with the one being
// typed in bold, from the function help in the app's language (formula/help/). Drawn in the app's tooltip look, but kept
// while typing, and placed under the cell editor or the formula bar, whichever has the caret.

import { h } from '../ui/dom.ts';
import { announce } from '../ui/announce.ts';
import { t } from '../i18n/index.ts';
import { argumentIndex, functionHelp, splitArgs, type FunctionHelp } from './formula/help/index.ts';

/** The function call the caret is inside, in formula text: its name (upper case) and which argument (from 0) the caret is in. */
export function callAt(text: string, caret: number): { name: string; arg: number } | null {
  if (!text.startsWith('=')) return null;
  const stack: { name: string; arg: number }[] = [];
  let braces = 0;
  for (let i = 1; i < caret && i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // A string: "" inside it is a quote.
      i++;
      while (i < caret && i < text.length && !(text[i] === '"' && text[i + 1] !== '"')) i += text[i] === '"' ? 2 : 1;
      continue;
    }
    if (c === "'") {
      // A quoted sheet name.
      i++;
      while (i < caret && i < text.length && !(text[i] === "'" && text[i + 1] !== "'")) i += text[i] === "'" ? 2 : 1;
      continue;
    }
    if (c === '{') braces++;
    else if (c === '}') braces = Math.max(0, braces - 1);
    else if (c === '(') {
      const name = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(text.slice(1, i))?.[1] ?? '';
      stack.push({ name: name.toUpperCase().replace(/^_XLFN\./, ''), arg: 0 });
    } else if (c === ')') stack.pop();
    else if (c === ',' && !braces && stack.length) stack[stack.length - 1].arg++;
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name) return stack[i];
  return null;
}

/** The hint card: `update` with the editor's text, caret and where it is on screen; `hide` when editing ends. */
export class FormulaHint {
  private readonly el = h('div', { class: 'wm-tip shown wm-formula-hint', attrs: { role: 'tooltip', popover: 'manual' } });
  private help: FunctionHelp | null = null;
  private loading: Promise<void> | null = null;
  /** What was said last, so a screen reader hears it once each time the argument changes. */
  private said = '';

  constructor(private readonly locale: () => string) {
    document.body.append(this.el);
  }

  update(text: string, caret: number, at: { left: number; top: number }): void {
    const call = callAt(text, caret);
    if (!call) return this.hide();
    if (!this.help) {
      this.loading ??= functionHelp(this.locale()).then((help) => {
        this.help = help;
      });
      void this.loading.then(() => this.update(text, caret, at));
      return;
    }
    const entry = this.help[call.name];
    if (!entry) return this.hide();
    const args = splitArgs(entry[0]);
    const current = argumentIndex(args, call.arg);
    this.el.replaceChildren(
      h('span', { text: `${call.name}(` }),
      ...args.flatMap((a, i) => [...(i ? [h('span', { text: ', ' })] : []), i === current ? h('b', { text: a }) : h('span', { text: a })]),
      h('span', { text: ')' }),
    );
    // The top layer, as the app's tooltip: above the toolbars and the sheet.
    if (!this.el.matches(':popover-open')) this.el.showPopover?.();
    this.el.style.left = `${Math.max(4, Math.min(at.left, window.innerWidth - this.el.offsetWidth - 4))}px`;
    this.el.style.top = `${at.top + 4}px`;
    const say = args[current] ? t('sheet.fn.hint', { name: call.name, arg: args[current].replace(/^\[|\]$/g, '') }) : '';
    if (say && say !== this.said) announce(say);
    this.said = say;
  }

  hide(): void {
    if (this.el.matches(':popover-open')) this.el.hidePopover?.();
    this.said = '';
  }
}
