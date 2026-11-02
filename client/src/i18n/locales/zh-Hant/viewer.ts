import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': '正在開啟 {name}…',
  'viewer.cannotOpen': '無法顯示 {name}：Golem Docs 無法開啟這種檔案。',
  'viewer.document': '文件',
  'viewer.previousPage': '上一頁',
  'viewer.nextPage': '下一頁',
  'viewer.pageNumber': '頁碼',
  'viewer.pageCount': '/ {count}',
  'viewer.zoomIn': '放大',
  'viewer.zoomOut': '縮小',
  'viewer.actualSize': '實際大小',
  'viewer.find': '尋找',
  'viewer.closeFind': '關閉尋找',
  'viewer.findUnavailable': 'PDF 的原始頁面中暫時無法尋找。',
  'viewer.signIn': '登入',
  'viewer.signInToView': '登入後即可檢視此文件。',
  'viewer.viewOnlyTitle': '{name}（僅檢視）',
};
