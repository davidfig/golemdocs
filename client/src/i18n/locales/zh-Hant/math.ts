import type { Messages } from '../../index.ts';

export const math: Partial<Messages> = {
  'math.insert': '公式(&Q)…',
  'math.insert.tip': '插入公式',
  'math.title': '插入公式',
  'math.close': '關閉',
  'math.latexLabel': 'LaTeX 公式',
  'math.latexField': '公式 (LaTeX)：',
  'math.hint': '像 LaTeX 那樣書寫數學，例如 \\frac{a}{b}, x^2 + \\sqrt{y}, \\sum_{i=1}^{n} i',
  'math.displayLabel': '單獨一行顯示',
  'math.ok': '插入',
  'math.cancel': '取消',
  'math.empty': '請輸入公式。',
  'math.problems': '無法辨識，保持原樣：',
  'math.editTitle': '編輯公式',
  'math.update': '更新',
  'math.preview': '預覽',
  'math.tab.structures': '結構',
  'math.tab.greek': '希臘字母',
  'math.tab.operators': '運算子',
  'math.tab.relations': '關係',
  'math.tab.arrows': '箭頭',
};
