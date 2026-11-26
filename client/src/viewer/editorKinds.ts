// Which files the viewer shows in one of the app's own editors (editorViews.ts) rather than with the layout worker.

import type { DocumentSource } from '../layout/protocol.ts';

export type EditorKind = 'sheet' | 'slides' | 'media';

/** Which editor shows a file, or null for one the layout worker shows. A CSV kept as a document (.wdoc) is a sheet too. */
export function editorFor(source: DocumentSource): EditorKind | null {
  if (!('bytes' in source)) return null;
  if (source.kind === 'xlsx' || source.kind === 'csv' || source.kind === 'tsv') return 'sheet';
  if (source.kind === 'wdoc' && /\.(csv|tsv|tab)$/i.test(source.name)) return 'sheet';
  if (source.kind === 'pptx') return 'slides';
  if (source.kind === 'audio' || source.kind === 'video') return 'media';
  return null;
}

