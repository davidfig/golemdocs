import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': 'Apertura di {name}…',
  'viewer.cannotOpen': 'Impossibile mostrare {name}: Golem Docs non apre questo tipo di file.',
  'viewer.document': 'Documento',
  'viewer.previousPage': 'Pagina precedente',
  'viewer.nextPage': 'Pagina successiva',
  'viewer.pageNumber': 'Numero di pagina',
  'viewer.pageCount': 'di {count}',
  'viewer.zoomIn': 'Ingrandisci',
  'viewer.zoomOut': 'Riduci',
  'viewer.actualSize': 'Dimensioni effettive',
  'viewer.find': 'Trova',
  'viewer.closeFind': 'Chiudi ricerca',
  'viewer.findUnavailable': 'La ricerca non è ancora disponibile nelle pagine originali di un PDF.',
  'viewer.signIn': 'Accedi',
  'viewer.signInToView': 'Accedi per vedere questo documento.',
  'viewer.viewOnlyTitle': '{name} (sola lettura)',
};
