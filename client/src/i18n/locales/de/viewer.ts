import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': '{name} wird geöffnet …',
  'viewer.cannotOpen': '{name} kann nicht angezeigt werden: Golem Docs öffnet diese Art von Datei nicht.',
  'viewer.document': 'Dokument',
  'viewer.previousPage': 'Vorherige Seite',
  'viewer.nextPage': 'Nächste Seite',
  'viewer.pageNumber': 'Seitenzahl',
  'viewer.pageCount': 'von {count}',
  'viewer.zoomIn': 'Vergrößern',
  'viewer.zoomOut': 'Verkleinern',
  'viewer.actualSize': 'Originalgröße',
  'viewer.find': 'Suchen',
  'viewer.closeFind': 'Suche schließen',
  'viewer.findUnavailable': 'Die Suche ist in den eigenen Seiten eines PDFs noch nicht verfügbar.',
  'viewer.signInToView': 'Melden Sie sich an, um dieses Dokument zu sehen.',
  'viewer.viewOnlyTitle': '{name} (nur Lesen)',
};
