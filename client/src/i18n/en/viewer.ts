// The embeddable viewer (src/viewer/): a document shown read-only, with page, zoom and find controls.

export const viewer = {
  'viewer.opening': 'Opening {name}…',
  'viewer.cannotOpen': '{name} can\'t be shown: Golem Docs doesn\'t open this kind of file.',
  'viewer.document': 'Document',
  'viewer.previousPage': 'Previous Page',
  'viewer.nextPage': 'Next Page',
  'viewer.pageNumber': 'Page number',
  'viewer.pageCount': 'of {count}',
  'viewer.zoomIn': 'Zoom In',
  'viewer.zoomOut': 'Zoom Out',
  'viewer.actualSize': 'Actual Size',
  'viewer.find': 'Find',
  'viewer.closeFind': 'Close Find',
  'viewer.findUnavailable': 'Find isn\'t available in a PDF\'s own pages yet.',
} as const;
