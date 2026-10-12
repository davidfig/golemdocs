// What a link's address may be (Insert ▸ Hyperlink, see linkPopover.ts for the form; the editor does the linking, see @golemdocs/editor).

import { parseTagAddress } from '@golemdocs/docx';
import { docAddress, parseDocAddress } from '../formats/wikiLinks.ts';

/** Schemes a link may open. Anything else (javascript:, data:…) is refused. */
const SAFE = /^(https?|mailto|tel|ftp):/i;

/**
 * The address as a link should store it: what's typed, with a scheme added when it has none
 * ("example.com" is a web page, "ada@example.com" an e-mail address). Null when it isn't a link
 * the app opens, or is empty.
 */
export function linkAddress(text: string): string | null {
  const address = text.trim();
  if (!address) return null;
  if (address.startsWith('#')) return address.length > 1 ? address : null;
  // A link to another stored document: doc:Title, or [[Title]] as a wiki writes it.
  const wiki = /^\[\[([^\]|]+)\]\]$/.exec(address);
  if (wiki) return docAddress(wiki[1].trim());
  if (/^doc:/i.test(address)) return parseDocAddress(address) ? address : null;
  // A link to a tag: tag:name.
  if (/^tag:/i.test(address)) return parseTagAddress(address) ? address : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(address)) return SAFE.test(address) ? address : null;
  if (/^[^\s@/]+@[^\s@/]+$/.test(address)) return `mailto:${address}`;
  return /\s/.test(address) ? null : `https://${address}`;
}

/** Whether a link is one the app opens in a new tab when it is Ctrl+clicked. */
export const opensLink = (url: string): boolean => SAFE.test(url);

export interface LinkChoice {
  url: string;
  text: string;
}
