// Hand-written ODT fixtures shaped like LibreOffice Writer output (there are no .odt files in
// the repo), zipped with the docx package's writer.

import { writeZip } from '@word/docx';

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:officeooo="http://openoffice.org/2009/office"',
  'xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"',
].join(' ');

export const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export const FONT_DECLS = `<office:font-face-decls>
  <style:font-face style:name="Liberation Serif" svg:font-family="&apos;Liberation Serif&apos;" style:font-family-generic="roman" style:font-pitch="variable"/>
  <style:font-face style:name="Liberation Sans" svg:font-family="&apos;Liberation Sans&apos;" style:font-family-generic="swiss" style:font-pitch="variable"/>
  <style:font-face style:name="DejaVu Sans Mono" svg:font-family="&apos;DejaVu Sans Mono&apos;" style:font-family-generic="modern" style:font-pitch="fixed"/>
</office:font-face-decls>`;

export const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS} office:version="1.3">
${FONT_DECLS}
<office:styles>
  <style:default-style style:family="graphic"><style:graphic-properties svg:stroke-color="#3465a4"/></style:default-style>
  <style:default-style style:family="paragraph">
    <style:paragraph-properties fo:orphans="2" fo:widows="2" fo:hyphenation-ladder-count="no-limit" style:text-autospace="ideograph-alpha" style:tab-stop-distance="1.251cm" style:writing-mode="page"/>
    <style:text-properties style:use-window-font-color="true" style:font-name="Liberation Serif" fo:font-size="12pt" fo:language="en" fo:country="US" style:letter-kerning="true" fo:hyphenate="false"/>
  </style:default-style>
  <style:style style:name="Standard" style:family="paragraph" style:class="text"/>
  <style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Text_20_body" style:class="text">
    <style:paragraph-properties fo:margin-top="0.423cm" fo:margin-bottom="0.212cm" style:contextual-spacing="false" fo:keep-with-next="always"/>
    <style:text-properties style:font-name="Liberation Sans" fo:font-size="14pt"/>
  </style:style>
  <style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text">
    <style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.247cm" style:contextual-spacing="false" fo:line-height="115%"/>
  </style:style>
  <style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="1" style:class="text">
    <style:paragraph-properties fo:margin-top="0.423cm" fo:margin-bottom="0.212cm"/>
    <style:text-properties fo:font-size="130%" fo:font-weight="bold" style:font-weight-complex="bold"/>
  </style:style>
  <style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="2" style:class="text">
    <style:text-properties fo:font-size="115%" fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard" style:class="html">
    <style:paragraph-properties fo:margin-left="1cm" fo:margin-right="1cm" fo:text-indent="0cm" style:auto-text-indent="false"/>
  </style:style>
  <style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra">
    <style:paragraph-properties fo:orphans="0" fo:widows="0" text:number-lines="false"/>
  </style:style>
  <style:style style:name="Internet_20_link" style:display-name="Internet link" style:family="text">
    <style:text-properties fo:color="#000080" loext:opacity="100%" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/>
  </style:style>
  <style:style style:name="Strong_20_Emphasis" style:display-name="Strong Emphasis" style:family="text">
    <style:text-properties fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Source_20_Text" style:display-name="Source Text" style:family="text">
    <style:text-properties style:font-name="DejaVu Sans Mono"/>
  </style:style>
  <style:style style:name="Frame" style:family="graphic"><style:graphic-properties text:anchor-type="paragraph"/></style:style>
  <text:outline-style style:name="Outline">
    <text:outline-level-style text:level="1" style:num-format=""><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab"/></style:list-level-properties></text:outline-level-style>
  </text:outline-style>
  <text:notes-configuration text:note-class="footnote" style:num-format="1" text:start-value="0" text:footnotes-position="page" text:start-numbering-at="document"/>
</office:styles>
<office:automatic-styles>
  <style:style style:name="MP1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/></style:style>
  <style:page-layout style:name="pm1">
    <style:page-layout-properties fo:page-width="21.001cm" fo:page-height="29.7cm" style:num-format="1" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm" style:writing-mode="lr-tb" style:footnote-max-height="0cm" loext:margin-gutter="0cm">
      <style:footnote-sep style:width="0.018cm" style:distance-before-sep="0.101cm" style:distance-after-sep="0.101cm" style:line-style="solid" style:adjustment="left" style:rel-width="25%" style:color="#000000"/>
    </style:page-layout-properties>
    <style:header-style/>
    <style:footer-style><style:header-footer-properties fo:min-height="0cm" fo:margin-top="0.5cm"/></style:footer-style>
  </style:page-layout>
</office:automatic-styles>
<office:master-styles>
  <style:master-page style:name="Standard" style:page-layout-name="pm1">
    <style:footer><text:p text:style-name="MP1">Page <text:page-number text:select-page="current">1</text:page-number> of <text:page-count>2</text:page-count></text:p></style:footer>
  </style:master-page>
</office:master-styles>
</office:document-styles>`;

export const CONTENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS} office:version="1.3">
<office:scripts/>
${FONT_DECLS}
<office:automatic-styles>
  <style:style style:name="Table1" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>
  <style:style style:name="Table1.A" style:family="table-column"><style:table-column-properties style:column-width="5cm"/></style:style>
  <style:style style:name="Table1.B" style:family="table-column"><style:table-column-properties style:column-width="12cm"/></style:style>
  <style:style style:name="Table1.A1" style:family="table-cell"><style:table-cell-properties fo:background-color="#dddddd" fo:padding="0.097cm" fo:border="0.5pt solid #000000"/></style:style>
  <style:style style:name="P0" style:family="paragraph" style:parent-style-name="Heading_20_1" style:master-page-name="Standard"/>
  <style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard">
    <style:paragraph-properties fo:text-align="center" style:justify-single-word="false" style:page-number="auto"/>
    <style:text-properties officeooo:rsid="0012ab34" officeooo:paragraph-rsid="0012ab34"/>
  </style:style>
  <style:style style:name="P2" style:family="paragraph" style:parent-style-name="Text_20_body">
    <style:paragraph-properties fo:margin-left="0.5in" fo:text-indent="-0.25in" fo:line-height="150%" fo:hyphenation-ladder-count="3"/>
  </style:style>
  <style:style style:name="P3" style:family="paragraph" style:parent-style-name="Text_20_body">
    <style:text-properties fo:font-size="10pt" style:font-name="Liberation Sans"/>
  </style:style>
  <style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"/></style:style>
  <style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
  <style:style style:name="T3" style:family="text"><style:text-properties fo:color="#c9211e" style:text-line-through-style="solid" fo:background-color="#ffff00"/></style:style>
  <style:style style:name="T4" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
  <style:style style:name="T5" style:family="text"><style:text-properties style:text-position="sub 58%" style:font-name="DejaVu Sans Mono" fo:font-size="150%"/></style:style>
  <style:style style:name="Sect1" style:family="section"><style:section-properties style:editable="false"><style:columns fo:column-count="2" fo:column-gap="0.5cm"/></style:section-properties></style:style>
  <style:style style:name="fr1" style:family="graphic" style:parent-style-name="Frame"><style:graphic-properties style:wrap="parallel" style:vertical-pos="top" style:horizontal-pos="right"/></style:style>
  <style:style style:name="fr2" style:family="graphic" style:parent-style-name="Frame"><style:graphic-properties style:wrap="none"/></style:style>
  <style:style style:name="P9" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="end"/></style:style>
  <number:date-style style:name="N37" number:automatic-order="true"><number:day/><number:text>/</number:text><number:month/><number:text>/</number:text><number:year/></number:date-style>
  <text:list-style style:name="L1">
    <text:list-level-style-bullet text:level="1" text:style-name="Bullet_20_Symbols" text:bullet-char="•">
      <style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.635cm" fo:text-indent="-0.635cm" fo:margin-left="0.635cm"/></style:list-level-properties>
    </text:list-level-style-bullet>
    <text:list-level-style-bullet text:level="2" text:bullet-char="◦">
      <style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties>
    </text:list-level-style-bullet>
  </text:list-style>
  <text:list-style style:name="L2">
    <text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1" text:start-value="3">
      <style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties>
    </text:list-level-style-number>
    <text:list-level-style-number text:level="2" style:num-suffix=")" style:num-format="a" text:display-levels="2">
      <style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="space" fo:text-indent="-0.635cm" fo:margin-left="1.905cm"/></style:list-level-properties>
    </text:list-level-style-number>
  </text:list-style>
</office:automatic-styles>
<office:body>
<office:text>
  <text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Illustration"/></text:sequence-decls>
  <draw:frame draw:style-name="fr2" draw:name="PageFrame" text:anchor-type="page" text:anchor-page-number="1" svg:x="1cm" svg:y="1cm" svg:width="3cm" draw:z-index="1"><draw:text-box><text:p text:style-name="P9">Floating box</text:p></draw:text-box></draw:frame>
  <text:h text:style-name="P0" text:outline-level="1">Report <text:span text:style-name="T1">Title</text:span></text:h>
  <text:p text:style-name="P1">Centered   and <text:span text:style-name="T1">bold</text:span>, <text:span text:style-name="T2">italic underlined</text:span>, <text:span text:style-name="T3">red struck highlighted</text:span>, E=mc<text:span text:style-name="T4">2</text:span> H<text:span text:style-name="T5">2</text:span>O.</text:p>
  <text:p text:style-name="Text_20_body">Spaces:<text:s text:c="3"/>three<text:tab/>tab<text:line-break/>new line <text:span text:style-name="Strong_20_Emphasis">strong</text:span><text:soft-page-break/> after soft break.</text:p>
  <text:p text:style-name="P2">Indented hanging paragraph with a <text:a xlink:type="simple" xlink:href="https://example.com/a?b=1&amp;c=2" text:style-name="Internet_20_link" text:visited-style-name="Visited_20_Internet_20_Link">link <text:span text:style-name="T1">here</text:span></text:a> and a <text:a xlink:type="simple" xlink:href="#Target">jump</text:a>.</text:p>
  <text:p text:style-name="P3">Small sans text<office:annotation office:name="__Annotation__1_1"><dc:creator>Ada Lovelace</dc:creator><dc:date>2024-05-01T10:00:00</dc:date><meta:creator-initials>AL</meta:creator-initials><text:p text:style-name="P9">A comment</text:p><text:p>Second line</text:p></office:annotation> with a comment<office:annotation-end office:name="__Annotation__1_1"/> range and <text:bookmark-start text:name="Target"/>a bookmark<text:bookmark-end text:name="Target"/>.</text:p>
  <text:p text:style-name="Standard">Dated <text:date style:data-style-name="N37" text:date-value="2024-05-01">01/05/2024</text:date> by <text:author-name text:fixed="false">Ada</text:author-name>.</text:p>
  <text:list xml:id="list100" text:style-name="L1">
    <text:list-item><text:p text:style-name="Standard">First bullet</text:p>
      <text:list><text:list-item><text:p text:style-name="Standard">Nested bullet</text:p></text:list-item></text:list>
    </text:list-item>
    <text:list-item><text:p text:style-name="Standard">Second bullet</text:p><text:p text:style-name="Standard">Continuation</text:p></text:list-item>
  </text:list>
  <text:list xml:id="list200" text:style-name="L2">
    <text:list-item><text:p text:style-name="Standard">Three</text:p>
      <text:list><text:list-item><text:p text:style-name="Standard">Three a</text:p></text:list-item></text:list>
    </text:list-item>
    <text:list-item><text:p text:style-name="Standard">Four</text:p></text:list-item>
  </text:list>
  <text:p text:style-name="Quotations">Interruption.</text:p>
  <text:list xml:id="list300" text:continue-list="list200" text:style-name="L2">
    <text:list-item><text:p text:style-name="Standard">Five</text:p></text:list-item>
  </text:list>
  <table:table table:name="Table1" table:style-name="Table1">
    <table:table-column table:style-name="Table1.A"/>
    <table:table-column table:style-name="Table1.B"/>
    <table:table-header-rows>
      <table:table-row><table:table-cell table:style-name="Table1.A1" office:value-type="string"><text:p text:style-name="Table_20_Contents">Name</text:p></table:table-cell><table:table-cell table:style-name="Table1.A1" office:value-type="string"><text:p text:style-name="Table_20_Contents">Value</text:p></table:table-cell></table:table-row>
    </table:table-header-rows>
    <table:table-row><table:table-cell table:number-columns-spanned="2" office:value-type="string"><text:p text:style-name="Table_20_Contents">Spanning both</text:p></table:table-cell><table:covered-table-cell/></table:table-row>
    <table:table-row><table:table-cell table:number-rows-spanned="2" office:value-type="string"><text:p text:style-name="Table_20_Contents">Tall</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p text:style-name="Table_20_Contents">r3</text:p></table:table-cell></table:table-row>
    <table:table-row><table:covered-table-cell/><table:table-cell office:value-type="string"><text:p text:style-name="Table_20_Contents">r4</text:p></table:table-cell></table:table-row>
  </table:table>
  <text:section text:style-name="Sect1" text:name="Section1">
    <text:p text:style-name="Standard">In a section<draw:frame draw:style-name="fr1" draw:name="Picture 1" text:anchor-type="char" svg:width="2cm" svg:height="1cm" draw:z-index="0"><draw:image xlink:href="Pictures/10000000000000010000000137A1A2E0.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="image/png"/><svg:desc>A dot</svg:desc></draw:frame> with a picture.</text:p>
    <text:p text:style-name="Standard">Footnote<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p text:style-name="P9">The note.</text:p></text:note-body></text:note> here.</text:p>
  </text:section>
  <text:h text:style-name="Heading_20_2" text:outline-level="2">End</text:h>
</office:text>
</office:body>
</office:document-content>`;

export const META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:meta><meta:creation-date>2024-05-01T09:00:00</meta:creation-date><dc:title>Fixture</dc:title><meta:generator>LibreOffice/7.6</meta:generator></office:meta></office:document-meta>`;

export const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.3"><office:settings><config:config-item-set config:name="ooo:configuration-settings"><config:config-item config:name="TabsRelativeToIndent" config:type="boolean">true</config:config-item></config:config-item-set></office:settings></office:document-settings>`;

const MANIFEST_XML = (extra: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
 <manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
 ${extra.join('\n ')}
</manifest:manifest>`;

export interface PackageOptions {
  content: string;
  styles?: string;
  meta?: string;
  settings?: string;
  files?: Record<string, Uint8Array>;
  mimetype?: string | null;
}

const enc = new TextEncoder();

/** Zips parts into an ODF package (mimetype first and stored, like a real one). */
export function odtPackage(options: PackageOptions): Promise<Uint8Array> {
  const entries: { name: string; data: Uint8Array; compress?: boolean }[] = [];
  if (options.mimetype !== null) entries.push({ name: 'mimetype', data: enc.encode(options.mimetype ?? 'application/vnd.oasis.opendocument.text'), compress: false });
  entries.push({ name: 'content.xml', data: enc.encode(options.content) });
  if (options.styles) entries.push({ name: 'styles.xml', data: enc.encode(options.styles) });
  if (options.meta) entries.push({ name: 'meta.xml', data: enc.encode(options.meta) });
  if (options.settings) entries.push({ name: 'settings.xml', data: enc.encode(options.settings) });
  const extra: string[] = [];
  for (const [name, data] of Object.entries(options.files ?? {})) {
    entries.push({ name, data, compress: false });
    extra.push(`<manifest:file-entry manifest:full-path="${name}" manifest:media-type="image/png"/>`);
  }
  entries.push({ name: 'META-INF/manifest.xml', data: enc.encode(MANIFEST_XML(extra)) });
  return writeZip(entries);
}

/** The LibreOffice-like document above. */
export function libreOfficeFixture(): Promise<Uint8Array> {
  return odtPackage({
    content: CONTENT_XML,
    styles: STYLES_XML,
    meta: META_XML,
    settings: SETTINGS_XML,
    files: { 'Pictures/10000000000000010000000137A1A2E0.png': PNG_1X1 },
  });
}

/** A minimal content.xml around some office:text content. */
export function minimalContent(body: string, automatic = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS} office:version="1.3"><office:automatic-styles>${automatic}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
}
