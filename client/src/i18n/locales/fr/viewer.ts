import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': 'Ouverture de {name}…',
  'viewer.cannotOpen': 'Impossible d\'afficher {name} : Golem Docs n\'ouvre pas ce type de fichier.',
  'viewer.document': 'Document',
  'viewer.previousPage': 'Page précédente',
  'viewer.nextPage': 'Page suivante',
  'viewer.pageNumber': 'Numéro de page',
  'viewer.pageCount': 'sur {count}',
  'viewer.zoomIn': 'Zoom avant',
  'viewer.zoomOut': 'Zoom arrière',
  'viewer.actualSize': 'Taille réelle',
  'viewer.find': 'Rechercher',
  'viewer.closeFind': 'Fermer la recherche',
  'viewer.findUnavailable': 'La recherche n\'est pas encore disponible dans les pages d\'origine d\'un PDF.',
  'viewer.signInToView': 'Connectez-vous pour voir ce document.',
  'viewer.viewOnlyTitle': '{name} (lecture seule)',
};
