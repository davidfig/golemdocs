// styles.xml, numbering.xml, theme and settings.

import type {
  AbstractNumbering,
  LevelOverride,
  Numbering,
  NumberingInstance,
  NumberingLevel,
  Settings,
  Style,
  StyleSheet,
  TableStyleCondition,
  ThemeFonts,
  ThemeFontSet,
} from '../model/types.ts';
import { child, el, elements, type XmlElement } from '../xml/xml.ts';
import { group, parseOnOff, readProps, Schema, val, writeProps, type ReadContext, type WriteContext } from './codec.ts';
import {
  PARAGRAPH_PROPERTIES,
  RUN_PROPERTIES,
  TABLE_CELL_PROPERTIES,
  TABLE_PROPERTIES,
  TABLE_ROW_PROPERTIES,
  readParagraphProperties,
  readRunProperties,
  writeParagraphProperties,
  writeRunProperties,
} from './properties.ts';

// --- Styles ------------------------------------------------------------------------------

const CONDITION = new Schema(
  [
    group('w:pPr', 'paragraphProperties', PARAGRAPH_PROPERTIES),
    group('w:rPr', 'runProperties', RUN_PROPERTIES),
    group('w:tblPr', 'tableProperties', TABLE_PROPERTIES),
    group('w:trPr', 'rowProperties', TABLE_ROW_PROPERTIES),
    group('w:tcPr', 'cellProperties', TABLE_CELL_PROPERTIES),
  ],
  ['w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr', 'w:tcPr'],
);

const STYLE = new Schema(
  [
    val('w:name', 'name'),
    val('w:basedOn', 'basedOn'),
    val('w:next', 'next'),
    val('w:link', 'link'),
    group('w:pPr', 'paragraphProperties', PARAGRAPH_PROPERTIES),
    group('w:rPr', 'runProperties', RUN_PROPERTIES),
    group('w:tblPr', 'tableProperties', TABLE_PROPERTIES),
    group('w:trPr', 'rowProperties', TABLE_ROW_PROPERTIES),
    group('w:tcPr', 'cellProperties', TABLE_CELL_PROPERTIES),
  ],
  [
    'w:name', 'w:aliases', 'w:basedOn', 'w:next', 'w:link', 'w:autoRedefine', 'w:hidden', 'w:uiPriority',
    'w:semiHidden', 'w:unhideWhenUsed', 'w:qFormat', 'w:locked', 'w:personal', 'w:personalCompose',
    'w:personalReply', 'w:rsid', 'w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr', 'w:tcPr', 'w:tblStylePr',
  ],
);

function readStyle(e: XmlElement, ctx: ReadContext): Style {
  const conditions: TableStyleCondition[] = [];
  const style = readProps<Style>(STYLE, e, ctx, (c) => {
    if (c.name !== 'w:tblStylePr' || Object.keys(c.attrs).length !== 1 || c.attrs['w:type'] === undefined) return false;
    conditions.push({ ...readProps<Omit<TableStyleCondition, 'type'>>(CONDITION, c, ctx), type: c.attrs['w:type'] as never });
    return true;
  });
  if (conditions.length) style.tableConditions = conditions;
  const { 'w:type': type, 'w:styleId': id, 'w:default': isDefault, 'w:customStyle': customStyle, ...rest } = e.attrs;
  style.type = (type ?? 'paragraph') as Style['type'];
  style.id = id ?? '';
  if (isDefault !== undefined) style.isDefault = parseOnOff(isDefault);
  if (customStyle !== undefined) style.customStyle = parseOnOff(customStyle);
  style.attrs = rest;
  return style;
}

function writeStyle(style: Style, ctx: WriteContext): XmlElement {
  const attrs: Record<string, string> = { 'w:type': style.type };
  if (style.isDefault !== undefined) attrs['w:default'] = style.isDefault ? '1' : '0';
  if (style.customStyle !== undefined) attrs['w:customStyle'] = style.customStyle ? '1' : '0';
  if (style.id !== '') attrs['w:styleId'] = style.id;
  const conditions = (style.tableConditions ?? []).map(
    (c) => writeProps(CONDITION, 'w:tblStylePr', c, ctx, { attrs: { 'w:type': c.type }, keepEmpty: true })!,
  );
  return writeProps(STYLE, 'w:style', style, ctx, { attrs: { ...attrs, ...style.attrs }, prepend: conditions, keepEmpty: true })!;
}

export function readStyles(root: XmlElement, ctx: ReadContext): StyleSheet {
  const sheet: StyleSheet = { styles: [], rootAttrs: { ...root.attrs } };
  for (const e of elements(root)) {
    if (e.name === 'w:docDefaults') {
      const rPr = child(child(e, 'w:rPrDefault') ?? e, 'w:rPr');
      const pPr = child(child(e, 'w:pPrDefault') ?? e, 'w:pPr');
      if (rPr) sheet.defaultRunProperties = readRunProperties(rPr, ctx);
      if (pPr) sheet.defaultParagraphProperties = readParagraphProperties(pPr, ctx);
      if (child(e, 'w:rPrDefault')) sheet.hasRunDefaults = true;
      if (child(e, 'w:pPrDefault')) sheet.hasParagraphDefaults = true;
    } else if (e.name === 'w:latentStyles') sheet.latentStyles = e;
    else if (e.name === 'w:style') sheet.styles.push(readStyle(e, ctx));
    else (sheet.extra ??= []).push(e);
  }
  return sheet;
}

export function writeStyles(sheet: StyleSheet, ctx: WriteContext): XmlElement {
  const children: XmlElement[] = [];
  const hasDefaults =
    sheet.defaultRunProperties || sheet.defaultParagraphProperties || sheet.hasRunDefaults || sheet.hasParagraphDefaults;
  if (hasDefaults) {
    const defaults: XmlElement[] = [];
    if (sheet.defaultRunProperties || sheet.hasRunDefaults) {
      const rPr = writeRunProperties(sheet.defaultRunProperties ?? {}, ctx, true)!;
      defaults.push(el('w:rPrDefault', {}, rPr.children.length ? [rPr] : []));
    }
    if (sheet.defaultParagraphProperties || sheet.hasParagraphDefaults) {
      const pPr = writeParagraphProperties(sheet.defaultParagraphProperties ?? {}, ctx, true)!;
      defaults.push(el('w:pPrDefault', {}, pPr.children.length ? [pPr] : []));
    }
    children.push(el('w:docDefaults', {}, defaults));
  }
  if (sheet.latentStyles) children.push(sheet.latentStyles);
  for (const style of sheet.styles) children.push(writeStyle(style, ctx));
  children.push(...(sheet.extra ?? []));
  return el('w:styles', sheet.rootAttrs, children);
}

// --- Numbering ---------------------------------------------------------------------------

const LEVEL = new Schema(
  [
    val('w:start', 'start', 'number'),
    val('w:numFmt', 'format'),
    val('w:lvlRestart', 'restart', 'number'),
    val('w:pStyle', 'paragraphStyle'),
    val('w:isLgl', 'isLegal', 'bool'),
    val('w:suff', 'suffix'),
    val('w:lvlText', 'text'),
    val('w:lvlPicBulletId', 'pictureBullet', 'number'),
    val('w:lvlJc', 'justification'),
    group('w:pPr', 'paragraphProperties', PARAGRAPH_PROPERTIES),
    group('w:rPr', 'runProperties', RUN_PROPERTIES),
  ],
  [
    'w:start', 'w:numFmt', 'w:lvlRestart', 'w:pStyle', 'w:isLgl', 'w:suff', 'w:lvlText', 'w:lvlPicBulletId',
    'w:legacy', 'w:lvlJc', 'w:pPr', 'w:rPr',
  ],
);

const ABSTRACT = new Schema(
  [val('w:multiLevelType', 'multiLevelType'), val('w:styleLink', 'styleLink'), val('w:numStyleLink', 'numStyleLink')],
  ['w:nsid', 'w:multiLevelType', 'w:tmpl', 'w:name', 'w:styleLink', 'w:numStyleLink', 'w:lvl'],
);

const INSTANCE = new Schema([val('w:abstractNumId', 'abstractId', 'number')], ['w:abstractNumId', 'w:lvlOverride']);
const OVERRIDE = new Schema([val('w:startOverride', 'startOverride', 'number')], ['w:startOverride', 'w:lvl']);

function readLevel(e: XmlElement, ctx: ReadContext): NumberingLevel {
  const level = readProps<NumberingLevel>(LEVEL, e, ctx);
  const { 'w:ilvl': ilvl, ...rest } = e.attrs;
  level.level = Number(ilvl ?? 0);
  level.attrs = rest;
  return level;
}

function writeLevel(level: NumberingLevel, ctx: WriteContext): XmlElement {
  return writeProps(LEVEL, 'w:lvl', level, ctx, { attrs: { 'w:ilvl': String(level.level), ...level.attrs }, keepEmpty: true })!;
}

export function readNumbering(root: XmlElement, ctx: ReadContext): Numbering {
  const numbering: Numbering = { abstracts: [], instances: [], extra: [], rootAttrs: { ...root.attrs } };
  for (const e of elements(root)) {
    if (e.name === 'w:abstractNum') {
      const levels: NumberingLevel[] = [];
      const abstract = readProps<AbstractNumbering>(ABSTRACT, e, ctx, (c) => {
        if (c.name !== 'w:lvl') return false;
        levels.push(readLevel(c, ctx));
        return true;
      });
      const { 'w:abstractNumId': id, ...rest } = e.attrs;
      abstract.id = Number(id);
      abstract.levels = levels;
      abstract.attrs = rest;
      numbering.abstracts.push(abstract);
    } else if (e.name === 'w:num') {
      const overrides: LevelOverride[] = [];
      const instance = readProps<NumberingInstance>(INSTANCE, e, ctx, (c) => {
        if (c.name !== 'w:lvlOverride' || Object.keys(c.attrs).length !== 1) return false;
        let definition: NumberingLevel | undefined;
        const override = readProps<LevelOverride & { extra?: unknown }>(OVERRIDE, c, ctx, (l) => {
          if (l.name !== 'w:lvl' || definition) return false;
          definition = readLevel(l, ctx);
          return true;
        });
        override.level = Number(c.attrs['w:ilvl']);
        if (definition) override.definition = definition;
        if (override.extra) return false; // unexpected content: keep the whole override verbatim
        overrides.push(override);
        return true;
      });
      const { 'w:numId': id, ...rest } = e.attrs;
      instance.id = Number(id);
      instance.overrides = overrides;
      instance.attrs = rest;
      numbering.instances.push(instance);
    } else {
      numbering.extra.push(e);
    }
  }
  return numbering;
}

export function writeNumbering(numbering: Numbering, ctx: WriteContext): XmlElement {
  const before = numbering.extra.filter((e) => e.name === 'w:numPicBullet');
  const after = numbering.extra.filter((e) => e.name !== 'w:numPicBullet');
  const abstracts = numbering.abstracts.map(
    (a) =>
      writeProps(ABSTRACT, 'w:abstractNum', a, ctx, {
        attrs: { 'w:abstractNumId': String(a.id), ...a.attrs },
        prepend: a.levels.map((l) => writeLevel(l, ctx)),
        keepEmpty: true,
      })!,
  );
  const instances = numbering.instances.map(
    (n) =>
      writeProps(INSTANCE, 'w:num', n, ctx, {
        attrs: { 'w:numId': String(n.id), ...n.attrs },
        prepend: n.overrides.map(
          (o) =>
            writeProps(OVERRIDE, 'w:lvlOverride', o, ctx, {
              attrs: { 'w:ilvl': String(o.level) },
              prepend: o.definition ? [writeLevel(o.definition, ctx)] : [],
              keepEmpty: true,
            })!,
        ),
        keepEmpty: true,
      })!,
  );
  return el('w:numbering', numbering.rootAttrs, [...before, ...abstracts, ...instances, ...after]);
}

// --- Theme and settings ------------------------------------------------------------------

function readFontSet(e: XmlElement | undefined): ThemeFontSet {
  if (!e) return {};
  const face = (name: string) => child(e, name)?.attrs.typeface || undefined;
  return { latin: face('a:latin'), eastAsia: face('a:ea'), cs: face('a:cs') };
}

export function readThemeFonts(root: XmlElement): ThemeFonts {
  const scheme = child(child(root, 'a:themeElements') ?? root, 'a:fontScheme');
  return {
    major: readFontSet(scheme && child(scheme, 'a:majorFont')),
    minor: readFontSet(scheme && child(scheme, 'a:minorFont')),
  };
}

export function readSettings(root: XmlElement): Settings {
  const tab = child(root, 'w:defaultTabStop')?.attrs['w:val'];
  const evenOdd = child(root, 'w:evenAndOddHeaders');
  return {
    defaultTabStop: tab !== undefined && !Number.isNaN(Number(tab)) ? Number(tab) : 720,
    evenAndOddHeaders: evenOdd ? parseOnOff(evenOdd.attrs['w:val']) : false,
  };
}
