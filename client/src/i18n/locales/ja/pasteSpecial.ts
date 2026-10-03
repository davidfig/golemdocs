import type { Messages } from '../../index.ts';

export const pasteSpecial: Partial<Messages> = {
  'pasteSpecial.title': '形式を選択して貼り付け',
  'pasteSpecial.as': '貼り付ける形式:',
  'pasteSpecial.html': '書式付きテキスト (HTML)',
  'pasteSpecial.text': 'テキスト',
  'pasteSpecial.empty': 'クリップボードに貼り付けられるものがありません。',
  'pasteSpecial.unavailable': 'このブラウザーではページがクリップボードを読み取れません。Ctrl+V または Cmd+V で貼り付けてください。',
  'pasteSpecial.ok': 'OK',
  'pasteSpecial.cancel': 'キャンセル',
};
