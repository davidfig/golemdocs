import type { Messages } from '../../index.ts';

export const pasteSpecial: Partial<Messages> = {
  'pasteSpecial.title': '选择性粘贴',
  'pasteSpecial.as': '粘贴为：',
  'pasteSpecial.html': '带格式文本（HTML）',
  'pasteSpecial.text': '纯文本',
  'pasteSpecial.empty': '剪贴板中没有可以粘贴的内容。',
  'pasteSpecial.unavailable': '此浏览器不允许网页读取剪贴板。请改用 Ctrl+V 或 Cmd+V 粘贴。',
  'pasteSpecial.ok': '确定',
  'pasteSpecial.cancel': '取消',
};
