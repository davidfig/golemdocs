import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': 'Abriendo {name}…',
  'viewer.cannotOpen': 'No se puede mostrar {name}: Golem Docs no abre este tipo de archivo.',
  'viewer.document': 'Documento',
  'viewer.previousPage': 'Página anterior',
  'viewer.nextPage': 'Página siguiente',
  'viewer.pageNumber': 'Número de página',
  'viewer.pageCount': 'de {count}',
  'viewer.zoomIn': 'Acercar',
  'viewer.zoomOut': 'Alejar',
  'viewer.actualSize': 'Tamaño real',
  'viewer.find': 'Buscar',
  'viewer.closeFind': 'Cerrar búsqueda',
  'viewer.findUnavailable': 'La búsqueda aún no está disponible en las páginas propias de un PDF.',
};
