// Style names: LibreOffice's built-in style names <-> Word's built-in style ids, so a heading
// stays a heading and body text stays body text across the two formats.

import { encodeStyleName } from './odf.ts';

/** [Word style id, Word style name] for ODF display names (lower case), per family. */
const PARAGRAPH_IN: Record<string, [string, string]> = {
  standard: ['Normal', 'Normal'],
  default: ['Normal', 'Normal'],
  'default style': ['Normal', 'Normal'],
  'default paragraph style': ['Normal', 'Normal'],
  normal: ['Normal', 'Normal'],
  'text body': ['BodyText', 'Body Text'],
  'body text': ['BodyText', 'Body Text'],
  title: ['Title', 'Title'],
  subtitle: ['Subtitle', 'Subtitle'],
  'list paragraph': ['ListParagraph', 'List Paragraph'],
  quotations: ['Quote', 'Quote'],
  quote: ['Quote', 'Quote'],
  caption: ['Caption', 'caption'],
  header: ['Header', 'header'],
  footer: ['Footer', 'footer'],
};
const TEXT_IN: Record<string, [string, string]> = {
  'internet link': ['Hyperlink', 'Hyperlink'],
  hyperlink: ['Hyperlink', 'Hyperlink'],
  'visited internet link': ['FollowedHyperlink', 'FollowedHyperlink'],
  followedhyperlink: ['FollowedHyperlink', 'FollowedHyperlink'],
  'strong emphasis': ['Strong', 'Strong'],
  strong: ['Strong', 'Strong'],
  emphasis: ['Emphasis', 'Emphasis'],
  'default paragraph font': ['DefaultParagraphFont', 'Default Paragraph Font'],
};

/** ODF display names for Word's built-in ids (the reverse of the tables above). */
const OUT: Record<string, string> = {
  Normal: 'Standard',
  BodyText: 'Text body',
  ListParagraph: 'List Paragraph',
  Quote: 'Quotations',
  Caption: 'Caption',
  Header: 'Header',
  Footer: 'Footer',
  Title: 'Title',
  Subtitle: 'Subtitle',
  Hyperlink: 'Internet link',
  FollowedHyperlink: 'Visited Internet Link',
  Strong: 'Strong Emphasis',
  Emphasis: 'Emphasis',
};

/** The Word id and name for an ODF style's display name; undefined for a custom style. */
export function wordStyleFor(family: 'paragraph' | 'text', display: string): [id: string, name: string] | undefined {
  const key = display.trim().toLowerCase();
  if (family === 'paragraph') {
    const heading = /^heading ([1-9])$/.exec(key);
    if (heading) return [`Heading${heading[1]}`, `heading ${heading[1]}`];
    return PARAGRAPH_IN[key];
  }
  return TEXT_IN[key];
}

/** A Word style id made from a custom display name (Word drops spaces and punctuation). */
export function customStyleId(display: string): string {
  const id = display.replace(/[^\p{L}\p{N}]/gu, '');
  return id || 'Style';
}

/** The ODF [style:name, display name] for a Word style. */
export function odfStyleName(id: string, name: string | undefined): [name: string, display: string] {
  const heading = /^Heading([1-9])$/.exec(id);
  const display = heading ? `Heading ${heading[1]}` : (OUT[id] ?? name ?? id);
  return [display === 'Standard' ? 'Standard' : encodeStyleName(display), display];
}
