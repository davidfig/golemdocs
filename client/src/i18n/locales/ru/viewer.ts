import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': 'Открывается {name}…',
  'viewer.cannotOpen': 'Не удаётся показать {name}: Golem Docs не открывает файлы этого типа.',
  'viewer.document': 'Документ',
  'viewer.previousPage': 'Предыдущая страница',
  'viewer.nextPage': 'Следующая страница',
  'viewer.pageNumber': 'Номер страницы',
  'viewer.pageCount': 'из {count}',
  'viewer.zoomIn': 'Увеличить',
  'viewer.zoomOut': 'Уменьшить',
  'viewer.actualSize': 'Реальный размер',
  'viewer.find': 'Найти',
  'viewer.closeFind': 'Закрыть поиск',
  'viewer.findUnavailable': 'Поиск пока недоступен на собственных страницах PDF.',
  'viewer.signInToView': 'Войдите, чтобы увидеть этот документ.',
  'viewer.viewOnlyTitle': '{name} (только просмотр)',
  'viewer.download': 'Скачать',
  'viewer.linkGone': 'Эта ссылка больше не работает: документ больше не опубликован.',
};
