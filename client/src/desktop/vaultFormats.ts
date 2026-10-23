// Which files the vault keeps, and in what format. Names only, so the page can ask without loading any converter (those are
// in the worker, see convertWorker.ts).
//
// Every file the app opens is kept. A few it reads but cannot write (legacy Word `.doc`, GIF, BMP, HEIC): the app edits
// them as another format (Word, PNG, JPEG), and that is what the vault writes once the app has saved one (see vaultCodec.ts).

import { isFormat, type Format } from '../formats/convert.ts';
import { sourceFromFile } from '../formats/source.ts';

/** The format a picture file is edited, and so written, as. */
function pictureFormat(name: string): Format {
  if (/\.(jpe?g|hei[cf])$/i.test(name)) return 'jpeg';
  return /\.webp$/i.test(name) ? 'webp' : 'png';
}

/** The format the vault writes a file named `name` in, or null when the vault does not keep such files. */
export function vaultFormat(name: string): Format | null {
  // By name alone: nothing here reads the bytes, so `.xml` (which needs them to tell DocBook from JATS) is a text file.
  const kind = sourceFromFile(name, new ArrayBuffer(0))?.kind;
  if (kind === 'doc') return 'docx';
  if (kind === 'image') return pictureFormat(name);
  if (kind === 'svg') return /\.svgz$/i.test(name) ? 'svgz' : 'svg';
  return kind && isFormat(kind) ? kind : null;
}

/** The kind of file a name is, as `sourceFromFile` tells it: the bytes of a file uploaded under this name are of this kind. */
export function vaultKind(name: string): string | null {
  return sourceFromFile(name, new ArrayBuffer(0))?.kind ?? null;
}
