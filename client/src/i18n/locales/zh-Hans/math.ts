import type { Messages } from '../../index.ts';

export const math: Partial<Messages> = {
  'math.insert': '公式(&Q)…',
  'math.insert.tip': '插入公式',
  'math.title': '插入公式',
  'math.latexLabel': 'LaTeX 公式',
  'math.latexField': '公式 (LaTeX):',
  'math.hint': '像 LaTeX 那样书写数学，例如 \\frac{a}{b}, x^2 + \\sqrt{y}, \\sum_{i=1}^{n} i',
  'math.displayLabel': '单独一行显示',
  'math.ok': '插入',
  'math.cancel': '取消',
  'math.empty': '请输入公式。',
  'math.problems': '无法识别，保持原样：',
  'math.editTitle': '编辑公式',
  'math.update': '更新',
  'math.preview': '预览',
  'math.tab.structures': '结构',
  'math.tab.greek': '希腊字母',
  'math.tab.operators': '运算符',
  'math.tab.relations': '关系',
  'math.tab.arrows': '箭头',
};
