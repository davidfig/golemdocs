import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': '{name} を開いています…',
  'viewer.cannotOpen': '{name} は表示できません: Golem Docs はこの種類のファイルを開けません。',
  'viewer.document': '文書',
  'viewer.previousPage': '前のページ',
  'viewer.nextPage': '次のページ',
  'viewer.pageNumber': 'ページ番号',
  'viewer.pageCount': '/ {count}',
  'viewer.zoomIn': '拡大',
  'viewer.zoomOut': '縮小',
  'viewer.actualSize': '実際のサイズ',
  'viewer.find': '検索',
  'viewer.closeFind': '検索を閉じる',
  'viewer.findUnavailable': 'PDF の元のページではまだ検索できません。',
  'viewer.signInToView': 'この文書を見るにはサインインしてください。',
  'viewer.viewOnlyTitle': '{name}（閲覧のみ）',
  'viewer.download': 'ダウンロード',
  'viewer.linkGone': 'このリンクは使えなくなりました。文書は公開されていません。',
};
