// OpenDocument Text (.odt) import and export for the WordDocument model.
//
// readOdt turns an .odt (or flat .fodt) into the WordDocument core plus an OdtExtension holding
// what only ODF can express; writeOdt writes the core (plus the extension, when given) as an
// ODF 1.3 package. See read.ts and write.ts for the mapping, extension.ts for the extension.

export { readOdt } from './read.ts';
export { writeOdt } from './write.ts';
export { OdtError, MIME_TEXT as ODT_MIME } from './odf.ts';
export type * from './extension.ts';
