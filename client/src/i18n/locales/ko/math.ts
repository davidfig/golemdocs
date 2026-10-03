import type { Messages } from '../../index.ts';

export const math: Partial<Messages> = {
  'math.insert': '수식(&Q)…',
  'math.insert.tip': '수식 삽입',
  'math.title': '수식 삽입',
  'math.latexLabel': 'LaTeX 수식',
  'math.latexField': '수식(LaTeX):',
  'math.hint': 'LaTeX처럼 수식을 입력하세요. 예: \\frac{a}{b}, x^2 + \\sqrt{y}, \\sum_{i=1}^{n} i',
  'math.displayLabel': '별도의 줄에 표시',
  'math.ok': '삽입',
  'math.cancel': '취소',
  'math.empty': '수식을 입력하세요.',
  'math.problems': '이해하지 못해 입력한 그대로 둔 부분:',
  'math.editTitle': '수식 편집',
  'math.update': '업데이트',
  'math.preview': '미리 보기',
  'math.tab.structures': '구조',
  'math.tab.greek': '그리스 문자',
  'math.tab.operators': '연산자',
  'math.tab.relations': '관계',
  'math.tab.arrows': '화살표',
};
