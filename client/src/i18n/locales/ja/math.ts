import type { Messages } from '../../index.ts';

export const math: Partial<Messages> = {
  'math.insert': '数式(&Q)…',
  'math.insert.tip': '数式を挿入',
  'math.title': '数式を挿入',
  'math.close': '閉じる',
  'math.latexLabel': 'LaTeX の数式',
  'math.latexField': '数式 (LaTeX):',
  'math.hint': 'LaTeX と同じ書き方で数式を入力します。例: \\frac{a}{b}, x^2 + \\sqrt{y}, \\sum_{i=1}^{n} i',
  'math.displayLabel': '独立した行に表示する',
  'math.ok': '挿入',
  'math.cancel': 'キャンセル',
  'math.empty': '数式を入力してください。',
  'math.problems': '解釈できず、入力のまま残す部分:',
  'math.editTitle': '数式を編集',
  'math.update': '更新',
  'math.preview': 'プレビュー',
  'math.tab.structures': '構造',
  'math.tab.greek': 'ギリシャ文字',
  'math.tab.operators': '演算子',
  'math.tab.relations': '関係',
  'math.tab.arrows': '矢印',
};
