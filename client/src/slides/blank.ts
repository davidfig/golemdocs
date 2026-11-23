// A new, empty deck (docs/slides.md): 16:9, Office's default look (its theme's colours and fonts), a master with its text
// styles, six layouts (Title Slide, Title and Content, Section Header, Two Content, Title Only, Blank), a notes master, and one
// Title Slide. Written as the parts PowerPoint itself writes, so it opens there without being repaired.

import { writeZip } from '@golemdocs/docx';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`;
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const rels = (list: [string, string, string][]): string =>
  `${DECL}<Relationships xmlns="${RELS}">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${OD}/${type}`}" Target="${target}"/>`).join('')}</Relationships>`;

const COLORS: [string, string][] = [
  ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
  ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
  ['dk2', '<a:srgbClr val="0E2841"/>'],
  ['lt2', '<a:srgbClr val="E8E8E8"/>'],
  ['accent1', '<a:srgbClr val="156082"/>'],
  ['accent2', '<a:srgbClr val="E97132"/>'],
  ['accent3', '<a:srgbClr val="196B24"/>'],
  ['accent4', '<a:srgbClr val="0F9ED5"/>'],
  ['accent5', '<a:srgbClr val="A02B93"/>'],
  ['accent6', '<a:srgbClr val="4EA72E"/>'],
  ['hlink', '<a:srgbClr val="467886"/>'],
  ['folHlink', '<a:srgbClr val="96607D"/>'],
];

const solid = (inner: string): string => `<a:solidFill><a:schemeClr val="phClr">${inner}</a:schemeClr></a:solidFill>`;
const grad = (stops: [number, string][], ang = 5400000): string =>
  `<a:gradFill rotWithShape="1"><a:gsLst>${stops.map(([pos, inner]) => `<a:gs pos="${pos}"><a:schemeClr val="phClr">${inner}</a:schemeClr></a:gs>`).join('')}</a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill>`;

function theme(name: string): string {
  const fills = [
    solid(''),
    grad([
      [0, '<a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/>'],
      [50000, '<a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/>'],
      [100000, '<a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/>'],
    ]),
    grad([
      [0, '<a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/>'],
      [50000, '<a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/>'],
      [100000, '<a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/>'],
    ]),
  ];
  const line = (w: number): string => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  const bg = [solid(''), solid('<a:tint val="95000"/><a:satMod val="170000"/>'), grad([
    [0, '<a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/>'],
    [50000, '<a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/>'],
    [100000, '<a:shade val="63000"/><a:satMod val="120000"/>'],
  ])];
  return `${DECL}<a:theme xmlns:a="${A}" name="${name}"><a:themeElements><a:clrScheme name="Office">${COLORS.map(([n, c]) => `<a:${n}>${c}</a:${n}>`).join('')}</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos" panose="02110004020202020204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${fills.join('')}</a:fillStyleLst><a:lnStyleLst>${line(12700)}${line(19050)}${line(25400)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${bg.join('')}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

const xfrm = (x: number, y: number, w: number, h: number): string => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;

/** A placeholder shape: `ph` its `p:ph` attributes, `pr` its `p:spPr` content, `body` its `a:bodyPr` and `a:lstStyle`, `text` its paragraphs. */
function ph(id: number, name: string, phAttrs: string, pr: string, body: string, text = '<a:p><a:endParaRPr lang="en-US"/></a:p>'): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${phAttrs}/></p:nvPr></p:nvSpPr><p:spPr>${pr}</p:spPr><p:txBody>${body}${text}</p:txBody></p:sp>`;
}

const prompt = (text: string): string => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`;
const levelsPrompt = '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US"/><a:t>Second level</a:t></a:r></a:p><a:p><a:pPr lvl="2"/><a:r><a:rPr lang="en-US"/><a:t>Third level</a:t></a:r></a:p><a:p><a:pPr lvl="3"/><a:r><a:rPr lang="en-US"/><a:t>Fourth level</a:t></a:r></a:p><a:p><a:pPr lvl="4"/><a:r><a:rPr lang="en-US"/><a:t>Fifth level</a:t></a:r></a:p>';

const tree = (shapes: string): string =>
  `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld>`;

const footers = (start: number): string =>
  ph(start, 'Date Placeholder', 'type="dt" sz="half" idx="10"', '', '<a:bodyPr/><a:lstStyle/>') +
  ph(start + 1, 'Footer Placeholder', 'type="ftr" sz="quarter" idx="11"', '', '<a:bodyPr/><a:lstStyle/>') +
  ph(start + 2, 'Slide Number Placeholder', 'type="sldNum" sz="quarter" idx="12"', '', '<a:bodyPr/><a:lstStyle/>', '<a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>');

const level = (n: number, marL: number, sz: number, spcBef: number): string =>
  `<a:lvl${n}pPr marL="${marL}" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="${spcBef}"/></a:spcBef><a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="•"/><a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;

const plainLevels = (): string =>
  Array.from({ length: 9 }, (_, i) => `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`).join('');

function master(): string {
  const shapes =
    ph(2, 'Title Placeholder 1', 'type="title"', `${xfrm(838200, 365125, 10515600, 1325563)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>', prompt('Click to edit Master title style')) +
    ph(3, 'Text Placeholder 2', 'type="body" idx="1"', `${xfrm(838200, 1825625, 10515600, 4351338)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>', levelsPrompt) +
    ph(4, 'Date Placeholder 3', 'type="dt" sz="half" idx="2"', `${xfrm(838200, 6356350, 2743200, 365125)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/><a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"><a:tint val="82000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>') +
    ph(5, 'Footer Placeholder 4', 'type="ftr" sz="quarter" idx="3"', `${xfrm(4038600, 6356350, 4114800, 365125)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"><a:tint val="82000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>') +
    ph(6, 'Slide Number Placeholder 5', 'type="sldNum" sz="quarter" idx="4"', `${xfrm(8610600, 6356350, 2743200, 365125)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/><a:lstStyle><a:lvl1pPr algn="r"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"><a:tint val="82000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>', '<a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>');
  const layouts = Array.from({ length: 6 }, (_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`).join('');
  const titleStyle = `<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>`;
  const sizes = [2800, 2400, 2000, 1800, 1800, 1800, 1800, 1800, 1800];
  const bodyStyle = `<p:bodyStyle>${sizes.map((sz, i) => level(i + 1, 228600 + i * 457200, sz, i ? 500 : 1000)).join('')}</p:bodyStyle>`;
  const otherStyle = `<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${plainLevels()}</p:otherStyle>`;
  return `${DECL}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${tree(shapes).slice('<p:cSld>'.length, -'</p:cSld>'.length)}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${layouts}</p:sldLayoutIdLst><p:txStyles>${titleStyle}${bodyStyle}${otherStyle}</p:txStyles></p:sldMaster>`;
}

interface LayoutSpec {
  name: string;
  type: string;
  shapes: string;
}

function layoutSpecs(): LayoutSpec[] {
  const centred = (sz: number, anchor = ''): string => `<a:bodyPr${anchor ? ` anchor="${anchor}"` : ''}><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="${sz}"/></a:lvl1pPr></a:lstStyle>`;
  return [
    {
      name: 'Title Slide',
      type: 'title',
      shapes:
        ph(2, 'Title 1', 'type="ctrTitle"', xfrm(1524000, 1122363, 9144000, 2387600), centred(6000, 'b'), prompt('Click to edit Master title style')) +
        ph(3, 'Subtitle 2', 'type="subTitle" idx="1"', xfrm(1524000, 3602038, 9144000, 1655762), '<a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle>', prompt('Click to edit Master subtitle style')) +
        footers(4),
    },
    {
      name: 'Title and Content',
      type: 'obj',
      shapes: ph(2, 'Title 1', 'type="title"', '', '<a:bodyPr/><a:lstStyle/>', prompt('Click to edit Master title style')) + ph(3, 'Content Placeholder 2', 'idx="1"', '', '<a:bodyPr/><a:lstStyle/>', levelsPrompt) + footers(4),
    },
    {
      name: 'Section Header',
      type: 'secHead',
      shapes:
        ph(2, 'Title 1', 'type="title"', xfrm(831850, 1709738, 10515600, 2852737), '<a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr><a:defRPr sz="6000"/></a:lvl1pPr></a:lstStyle>', prompt('Click to edit Master title style')) +
        ph(3, 'Text Placeholder 2', 'type="body" idx="1"', xfrm(831850, 4589463, 10515600, 1500187), '<a:bodyPr/><a:lstStyle><a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"><a:tint val="82000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>', prompt('Click to edit Master text styles')) +
        footers(4),
    },
    {
      name: 'Two Content',
      type: 'twoObj',
      shapes:
        ph(2, 'Title 1', 'type="title"', '', '<a:bodyPr/><a:lstStyle/>', prompt('Click to edit Master title style')) +
        ph(3, 'Content Placeholder 2', 'sz="half" idx="1"', xfrm(838200, 1825625, 5181600, 4351338), '<a:bodyPr/><a:lstStyle/>', levelsPrompt) +
        ph(4, 'Content Placeholder 3', 'sz="half" idx="2"', xfrm(6172200, 1825625, 5181600, 4351338), '<a:bodyPr/><a:lstStyle/>', levelsPrompt) +
        footers(5),
    },
    { name: 'Title Only', type: 'titleOnly', shapes: ph(2, 'Title 1', 'type="title"', '', '<a:bodyPr/><a:lstStyle/>', prompt('Click to edit Master title style')) + footers(3) },
    { name: 'Blank', type: 'blank', shapes: footers(2) },
  ];
}

const layoutXml = (spec: LayoutSpec): string => `${DECL}<p:sldLayout ${NS} type="${spec.type}" preserve="1"><p:cSld name="${spec.name}">${tree(spec.shapes).slice('<p:cSld>'.length)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

function notesMaster(): string {
  const shapes =
    ph(2, 'Header Placeholder 1', 'type="hdr" sz="quarter"', xfrm(0, 0, 2971800, 458788), '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle>') +
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Slide Image Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(685800, 1143000, 5486400, 3086100)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>` +
    ph(4, 'Notes Placeholder 3', 'type="body" sz="quarter" idx="3"', `${xfrm(685800, 4400550, 5486400, 3600450)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/>', levelsPrompt);
  const notesStyle = `<p:notesStyle>${Array.from({ length: 9 }, (_, i) => `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`).join('')}</p:notesStyle>`;
  return `${DECL}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${tree(shapes).slice('<p:cSld>'.length, -'</p:cSld>'.length)}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>${notesStyle}</p:notesMaster>`;
}

/** The first slide: a Title Slide with its two placeholders empty. */
const firstSlide = (): string =>
  `${DECL}<p:sld ${NS}>${tree(ph(2, 'Title 1', 'type="ctrTitle"', '', '<a:bodyPr/><a:lstStyle/>') + ph(3, 'Subtitle 2', 'type="subTitle" idx="1"', '', '<a:bodyPr/><a:lstStyle/>'))}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

function presentation(): string {
  return `${DECL}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${plainLevels()}</p:defaultTextStyle></p:presentation>`;
}

const CT = {
  pres: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  master: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  layout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  viewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
};

/** A new deck's `.pptx`. */
export async function blankDeck(): Promise<Uint8Array> {
  const specs = layoutSpecs();
  const files: [string, string][] = [];
  const overrides: [string, string][] = [
    ['/ppt/presentation.xml', CT.pres],
    ['/ppt/slideMasters/slideMaster1.xml', CT.master],
    ['/ppt/slides/slide1.xml', CT.slide],
    ['/ppt/notesMasters/notesMaster1.xml', CT.notesMaster],
    ['/ppt/theme/theme1.xml', CT.theme],
    ['/ppt/theme/theme2.xml', CT.theme],
    ['/ppt/presProps.xml', CT.presProps],
    ['/ppt/viewProps.xml', CT.viewProps],
    ['/ppt/tableStyles.xml', CT.tableStyles],
    ['/docProps/core.xml', CT.core],
    ['/docProps/app.xml', CT.app],
    ...specs.map((_, i): [string, string] => [`/ppt/slideLayouts/slideLayout${i + 1}.xml`, CT.layout]),
  ];
  files.push([
    '[Content_Types].xml',
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('')}</Types>`,
  ]);
  files.push(['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']])]);
  files.push(['docProps/core.xml', `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title></dc:title></cp:coreProperties>`]);
  files.push(['docProps/app.xml', `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Golem Docs</Application><Slides>1</Slides></Properties>`]);
  files.push(['ppt/presentation.xml', presentation()]);
  files.push(['ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'], ['rId3', 'slide', 'slides/slide1.xml'], ['rId4', 'presProps', 'presProps.xml'], ['rId5', 'viewProps', 'viewProps.xml'], ['rId6', 'theme', 'theme/theme1.xml'], ['rId7', 'tableStyles', 'tableStyles.xml']])]);
  files.push(['ppt/presProps.xml', `${DECL}<p:presentationPr ${NS}/>`]);
  files.push(['ppt/viewProps.xml', `${DECL}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`]);
  files.push(['ppt/tableStyles.xml', `${DECL}<a:tblStyleLst xmlns:a="${A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`]);
  files.push(['ppt/theme/theme1.xml', theme('Office Theme')]);
  files.push(['ppt/theme/theme2.xml', theme('Office Theme')]);
  files.push(['ppt/slideMasters/slideMaster1.xml', master()]);
  files.push(['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([...specs.map((_, i): [string, string, string] => [`rId${i + 1}`, 'slideLayout', `../slideLayouts/slideLayout${i + 1}.xml`]), [`rId${specs.length + 1}`, 'theme', '../theme/theme1.xml']])]);
  specs.forEach((spec, i) => {
    files.push([`ppt/slideLayouts/slideLayout${i + 1}.xml`, layoutXml(spec)]);
    files.push([`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])]);
  });
  files.push(['ppt/notesMasters/notesMaster1.xml', notesMaster()]);
  files.push(['ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([['rId1', 'theme', '../theme/theme2.xml']])]);
  files.push(['ppt/slides/slide1.xml', firstSlide()]);
  files.push(['ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])]);
  const enc = new TextEncoder();
  return writeZip(files.map(([name, text]) => ({ name, data: enc.encode(text) })));
}
