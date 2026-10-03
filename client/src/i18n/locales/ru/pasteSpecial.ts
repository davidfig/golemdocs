import type { Messages } from '../../index.ts';

export const pasteSpecial: Partial<Messages> = {
  'pasteSpecial.title': 'Специальная вставка',
  'pasteSpecial.as': 'Как:',
  'pasteSpecial.html': 'Форматированный текст (HTML)',
  'pasteSpecial.text': 'Неформатированный текст',
  'pasteSpecial.empty': 'В буфере обмена нет ничего, что можно вставить.',
  'pasteSpecial.unavailable': 'Этот браузер не разрешает странице читать буфер обмена. Вставьте с помощью Ctrl+V или Cmd+V.',
  'pasteSpecial.ok': 'ОК',
  'pasteSpecial.cancel': 'Отмена',
};
