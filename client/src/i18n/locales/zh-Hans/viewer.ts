import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': '正在打开 {name}…',
  'viewer.cannotOpen': '无法显示 {name}：Golem Docs 不能打开这种文件。',
  'viewer.document': '文档',
  'viewer.previousPage': '上一页',
  'viewer.nextPage': '下一页',
  'viewer.pageNumber': '页码',
  'viewer.pageCount': '/ {count}',
  'viewer.zoomIn': '放大',
  'viewer.zoomOut': '缩小',
  'viewer.actualSize': '实际大小',
  'viewer.find': '查找',
  'viewer.closeFind': '关闭查找',
  'viewer.findUnavailable': 'PDF 的原始页面中暂时无法查找。',
  'viewer.signIn': '登录',
  'viewer.signInToView': '登录后即可查看此文档。',
  'viewer.viewOnlyTitle': '{name}（仅查看）',
};
