// The ODT extension: what an OpenDocument text file can hold that the WordDocument core can't.
// It is plain JSON (strings, numbers, records, arrays), kept beside the core in the universal
// document, so switching to another format and back to ODT restores it.
//
// Anything tied to a place in the text is anchored by paragraph id (the paragraph's
// `w14:paraId`) and a model offset within it (see @word/docx edit/text.ts). On export, an
// anchor whose paragraph no longer exists, or whose offset is past the paragraph's end, is
// skipped silently; ranges whose end can't be placed after their start degrade to points.

/** A piece of ODF XML kept verbatim, with what it needs to stay valid when written back. */
export interface OdtFragment {
  /** The element, serialised without namespace declarations (they go on the part root). */
  xml: string;
  /**
   * Automatic styles (style:style, text:list-style, number:*-style ...) the XML refers to,
   * verbatim. They are renamed on export so they can't collide with generated styles.
   */
  styles?: string[];
  /** Embedded files the XML refers to (e.g. "Pictures/x.png"), base64, by package path. */
  media?: Record<string, string>;
  /** Manifest media types of those files and of embedded-object directories ("Object 1/"). */
  mediaTypes?: Record<string, string>;
}

/** Unmapped ODF formatting, per properties element ("style:text-properties" ...). */
export interface OdtProperties {
  /** Attributes the core couldn't express, by properties element, then qualified name. */
  attributes?: Record<string, Record<string, string>>;
  /**
   * Child elements the core couldn't express, verbatim XML, by the properties element they
   * belong in ("" for children of the style element itself, such as style:map).
   */
  children?: Record<string, string[]>;
}

/** Unmapped parts of a common style. */
export interface OdtStyleExtra extends OdtProperties {
  /** style:family, so an extra is only applied to a style of the same family. */
  family: string;
  /** Unmapped attributes of the style:style element itself (style:class, list-style-name ...). */
  styleAttributes?: Record<string, string>;
}

/** A position in the text. */
export interface OdtAnchor {
  paragraphId: string;
  /** Model offset within the paragraph. */
  offset: number;
}

/** An office:annotation (comment). */
export interface OdtAnnotation extends OdtAnchor {
  author?: string;
  /** ISO date-time as written in dc:date. */
  date?: string;
  initials?: string;
  /** The comment's text, one string per paragraph. */
  text: string[];
  /** Where a range comment ends (office:annotation-end); absent for a point comment. */
  end?: OdtAnchor;
  /** office:name linking the annotation to its end. */
  name?: string;
  /** The whole office:annotation element, written back as is. */
  fragment: OdtFragment;
}

/**
 * A container of block content the core flattens: text:section, or an index (table of
 * contents, alphabetical index, ...) whose generated body paragraphs are kept in the core.
 */
export interface OdtSection {
  /** "text:section", "text:table-of-content", ... */
  element: string;
  name?: string;
  /** The container's attributes (text:name, text:style-name, text:protected ...). */
  attributes: Record<string, string>;
  /** First and last core paragraphs inside the container. */
  firstParagraphId: string;
  lastParagraphId: string;
  /** Children before the content, verbatim: an index's *-source, a section's text:section-source. */
  prologue?: OdtFragment[];
  /** Automatic styles the container's own attributes refer to (its section style). */
  styles?: string[];
}

/** Frames, shapes, notes and other objects the core can't express, kept verbatim. */
export interface OdtObject {
  /**
   * "inline": inside the paragraph at the offset. "block": in the body after the block that
   * contains the paragraph (or at the very start when paragraphId is null).
   */
  placement: 'inline' | 'block';
  paragraphId: string | null;
  offset: number;
  fragment: OdtFragment;
}

/**
 * The draw:frame around an imported picture (anchoring, wrap, position), which the core's
 * inline drawing doesn't carry. Reapplied to the drawing at the same place when it's still an
 * image; size, name and picture come from the core.
 */
export interface OdtImageFrame extends OdtAnchor {
  /** The frame element without children, plus its automatic graphic style. */
  frame: OdtFragment;
}

export interface OdtBookmark extends OdtAnchor {
  name: string;
  /** Where a range bookmark ends; absent for a point bookmark (text:bookmark). */
  end?: OdtAnchor;
}

/**
 * A text field (date, author, chapter, sequence, cross-reference ...). The core holds its
 * displayed text as ordinary text; on export the element replaces that text if it's still
 * there unchanged.
 */
export interface OdtField extends OdtAnchor {
  /** The displayed text, as it is in the core. */
  text: string;
  fragment: OdtFragment;
}

/** Page setup the core's section can't express. */
export interface OdtPage {
  /** Unmapped page-layout properties (style:page-layout-properties and header/footer styles). */
  layout?: OdtProperties;
  /** Unmapped attributes of the master page. */
  masterAttributes?: Record<string, string>;
  /** Master-page children the core doesn't model (style:header-left, style:footer-left ...). */
  masterChildren?: OdtFragment[];
}

export interface OdtExtension {
  /** Version of this structure. */
  version: 1;
  /** meta.xml, verbatim. */
  meta?: string;
  /** settings.xml, verbatim. */
  settings?: string;
  /** Namespaces (prefix -> URI) the preserved XML uses beyond the standard ODF ones. */
  namespaces?: Record<string, string>;
  /** Unmapped formatting of common (named) styles, keyed by ODF style name. */
  styles?: Record<string, OdtStyleExtra>;
  /** Unmapped formatting of paragraphs' automatic styles, keyed by paragraph id. */
  paragraphs?: Record<string, OdtProperties>;
  /** office:styles children the core doesn't model (outline style, notes configuration ...). */
  styleDefinitions?: string[];
  /** Body children before the content: variable/sequence declarations, forms. */
  prologue?: OdtFragment[];
  page?: OdtPage;
  annotations?: OdtAnnotation[];
  sections?: OdtSection[];
  objects?: OdtObject[];
  imageFrames?: OdtImageFrame[];
  bookmarks?: OdtBookmark[];
  fields?: OdtField[];
}
