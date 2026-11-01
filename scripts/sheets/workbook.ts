// Writes small .xlsx packages for the spreadsheet tooling (scripts/sheets/): the generator's big test workbooks and the
// oracle's formula workbooks. Only what those need: sheets whose XML the caller writes, shared strings, a fixed set of
// styles, and the metadata part that marks dynamic-array formulas (cells with cm="1"). Not the app's writer (that is M1).

import { writeZip } from '../../docx/src/index.ts';

export interface SheetPart {
  name: string;
  /** The whole worksheet part, as pieces (a big sheet is too long for one string). */
  xml: (string | Uint8Array)[];
  /** Tables on the sheet (their header cells must hold the column names): a part each, linked from the sheet. */
  tables?: { name: string; ref: string; columns: string[]; style?: string }[];
}

export interface WorkbookParts {
  sheets: SheetPart[];
  sharedStrings?: string[];
  /** Adds xl/metadata.xml, which formulas written with `cm="1"` need to be dynamic arrays (they spill). */
  dynamicArrays?: boolean;
  /** Excel recalculates everything when it opens the file (for formulas written without cached values). */
  calculateOnLoad?: boolean;
}

/** Styles: 0 default, 1 header (bold, grey fill), 2 currency, 3 date (m/d/yyyy), 4 percent. Differential formats (for conditional formats): 0 dark red on light red, 1 light green fill. */
export const STYLE = { header: 1, currency: 2, date: 3, percent: 4 } as const;

export const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

export const WORKSHEET_START = `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">`;

const STYLES = `${XML}<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="2"><dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf><dxf><fill><patternFill><bgColor rgb="FFC6EFCE"/></patternFill></fill></dxf></dxfs></styleSheet>`;

/** The metadata Excel writes for dynamic-array formulas: one cell-metadata record (cm="1") meaning "this formula spills". */
const METADATA = `${XML}<metadata xmlns="${MAIN}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`;

export async function writeWorkbook(parts: WorkbookParts): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const { sheets, sharedStrings, dynamicArrays, calculateOnLoad } = parts;
  const overrides = [
    `<Override PartName="/xl/workbook.xml" ContentType="${TYPE}.sheet.main+xml"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="${TYPE}.styles+xml"/>`,
    ...sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${TYPE}.worksheet+xml"/>`),
    ...(sharedStrings ? [`<Override PartName="/xl/sharedStrings.xml" ContentType="${TYPE}.sharedStrings+xml"/>`] : []),
    ...(dynamicArrays ? [`<Override PartName="/xl/metadata.xml" ContentType="${TYPE}.sheetMetadata+xml"/>`] : []),
  ];
  // Tables: numbered across the workbook; each sheet with some links to them and lists them in <tableParts>.
  const tableFiles: [string, string][] = [];
  let tableId = 0;
  sheets.forEach((s, i) => {
    if (!s.tables?.length) return;
    const links: string[] = [];
    const parts: string[] = [];
    for (const t of s.tables) {
      const id = ++tableId;
      overrides.push(`<Override PartName="/xl/tables/table${id}.xml" ContentType="${TYPE}.table+xml"/>`);
      links.push(`<Relationship Id="rIdT${id}" Type="${REL}/table" Target="../tables/table${id}.xml"/>`);
      parts.push(`<tablePart r:id="rIdT${id}"/>`);
      const columns = t.columns.map((c, k) => `<tableColumn id="${k + 1}" name="${escapeXml(c)}"/>`).join('');
      tableFiles.push([
        `xl/tables/table${id}.xml`,
        `${XML}<table xmlns="${MAIN}" id="${id}" name="${escapeXml(t.name)}" displayName="${escapeXml(t.name)}" ref="${t.ref}"><autoFilter ref="${t.ref}"/><tableColumns count="${t.columns.length}">${columns}</tableColumns><tableStyleInfo name="${t.style ?? 'TableStyleMedium2'}" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`,
      ]);
    }
    tableFiles.push([`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.join('')}</Relationships>`]);
    // <tableParts> goes last in the worksheet.
    const last = s.xml.length - 1;
    const tail = s.xml[last];
    if (typeof tail !== 'string' || !tail.endsWith('</worksheet>')) throw new Error('a sheet with tables must end with a string piece');
    s.xml[last] = tail.slice(0, -'</worksheet>'.length) + `<tableParts count="${parts.length}">${parts.join('')}</tableParts></worksheet>`;
  });
  const rels = [
    ...sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`),
    `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`,
    ...(sharedStrings ? [`<Relationship Id="rIdStrings" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`] : []),
    ...(dynamicArrays ? [`<Relationship Id="rIdMetadata" Type="${REL}/sheetMetadata" Target="metadata.xml"/>`] : []),
  ];
  const files: [string, string | (string | Uint8Array)[]][] = [
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    [
      'xl/workbook.xml',
      `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029"${calculateOnLoad ? ' fullCalcOnLoad="1"' : ''}/></workbook>`,
    ],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i): [string, (string | Uint8Array)[]] => [`xl/worksheets/sheet${i + 1}.xml`, s.xml]),
  ];
  files.push(...tableFiles);
  if (sharedStrings) files.push(['xl/sharedStrings.xml', `${XML}<sst xmlns="${MAIN}" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('')}</sst>`]);
  if (dynamicArrays) files.push(['xl/metadata.xml', METADATA]);
  return writeZip(files.map(([name, data]) => ({ name, data: join(typeof data === 'string' ? [data] : data, encoder) })));
}

function join(pieces: (string | Uint8Array)[], encoder: TextEncoder): Uint8Array {
  const bytes = pieces.map((p) => (typeof p === 'string' ? encoder.encode(p) : p));
  if (bytes.length === 1) return bytes[0];
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bytes) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
