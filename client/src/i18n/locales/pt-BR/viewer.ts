import type { Messages } from '../../index.ts';

export const viewer: Partial<Messages> = {
  'viewer.opening': 'Abrindo {name}…',
  'viewer.cannotOpen': 'Não é possível mostrar {name}: o Golem Docs não abre este tipo de arquivo.',
  'viewer.document': 'Documento',
  'viewer.previousPage': 'Página anterior',
  'viewer.nextPage': 'Próxima página',
  'viewer.pageNumber': 'Número da página',
  'viewer.pageCount': 'de {count}',
  'viewer.zoomIn': 'Ampliar',
  'viewer.zoomOut': 'Reduzir',
  'viewer.actualSize': 'Tamanho real',
  'viewer.find': 'Localizar',
  'viewer.closeFind': 'Fechar localização',
  'viewer.findUnavailable': 'A localização ainda não está disponível nas páginas originais de um PDF.',
  'viewer.signInToView': 'Entre para ver este documento.',
  'viewer.viewOnlyTitle': '{name} (somente leitura)',
  'viewer.download': 'Baixar',
  'viewer.linkGone': 'Este link não funciona mais: o documento não está mais compartilhado publicamente.',
};
