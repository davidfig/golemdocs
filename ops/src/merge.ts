// A cautious three-way merge of two documents that were both changed from the same one: what the account has now ("theirs", saved
// by another device, or an ai app in a vault folder) and what this browser has ("mine"), both made from the version they last agreed on ("base").
//
// Each side's changes are found as operations from the base (diffDocuments), which address paragraphs by the base's ids. They are
// merged only when the two sides changed different paragraphs: neither changed, removed or anchored an insert on a paragraph the other
// changed or removed, they didn't both insert at the same place, and at most one of them added a list. Anything else (the same paragraph
// changed on both sides, a style or a comment changed, a picture added, or anything diffDocuments can't express) gives null, and the
// caller keeps the two versions apart as it always did. As a last check both sides' operations are applied in both orders, and the merge
// stands only if the two results are the same.
//
// What isn't the body (styles, the last section, settings, File › Properties, headers and footers) is taken whole from whichever side
// changed it, and is a conflict if both changed it differently: the app and the server write the same document a little differently
// there, so requiring it unchanged would refuse nearly every merge. Comments must be unchanged on both sides (their ranges are in the text).

import { formatId, DocumentIndex } from './ids.ts';
import { Engine } from './engine.ts';
import { canonical, copyDocument, diffDocuments, sameBody } from './diff.ts';
import { paragraphsIn, type WordDocument } from '@golemdocs/docx';
import type { Operation } from './types.ts';

/** What one side's operations change, and what they need left alone. */
interface Footprint {
  /** Blocks (by blockKey) whose content or properties change, or that go. */
  touched: Set<string>;
  removed: Set<string>;
  /** Paragraphs an operation is placed next to, which must still be there. */
  anchors: Set<string>;
  /** Where blocks go in: the anchor and which side of it. */
  inserts: Set<string>;
  lists: boolean;
}

/** The footprint of the operations diffDocuments makes; null for any other kind (not expected, so not merged). */
function footprint(ops: readonly Operation[]): Footprint | null {
  const f: Footprint = { touched: new Set(), removed: new Set(), anchors: new Set(), inserts: new Set(), lists: false };
  for (const op of ops) {
    switch (op.type) {
      case 'insertContent':
      case 'delete':
      case 'setParagraphProperties':
        f.touched.add(op.paragraph);
        break;
      case 'removeBlocks':
        for (const key of op.keys) {
          f.touched.add(key);
          f.removed.add(key);
        }
        f.anchors.add(op.after);
        break;
      case 'insertBlocks':
        f.anchors.add(op.after);
        f.inserts.add(`${op.after}${op.before ? '<' : '>'}`);
        break;
      case 'setList':
        f.lists = true;
        break;
      default:
        return null;
    }
  }
  return f;
}

const overlaps = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some((x) => b.has(x));

/** Whether the two sides' changes keep clear of each other (see the top of this file). */
function separate(a: Footprint, b: Footprint): boolean {
  if (a.lists && b.lists) return false;
  if (overlaps(a.touched, b.touched)) return false;
  if (overlaps(a.anchors, b.removed) || overlaps(b.anchors, a.removed)) return false;
  return !overlaps(a.inserts, b.inserts);
}

/** `ops` applied to a copy of `doc`; null if the engine refuses them. */
function applied(doc: WordDocument, ...batches: Operation[][]): WordDocument | null {
  const copy = copyDocument(doc);
  try {
    const engine = new Engine(copy);
    for (const ops of batches) engine.apply(ops);
  } catch {
    return null;
  }
  return copy;
}

/**
 * The base with both sides' changes, or null when they can't be merged with confidence. `base` gets paragraph ids where it lacks them
 * (as the editor would give them) and `mine` and `theirs` are normalized in place; none of the three is otherwise changed.
 */
export function mergeDocuments(base: WordDocument, mine: WordDocument, theirs: WordDocument): WordDocument | null {
  new DocumentIndex(base);
  if (canonical(mine.comments) !== canonical(base.comments) || canonical(theirs.comments) !== canonical(base.comments)) return null;
  const parts = mergeParts(base, mine, theirs);
  if (!parts) return null;
  // The bodies are compared with the base's other parts, so only the body is diffed.
  mine = withParts(mine, partsOf(base));
  theirs = withParts(theirs, partsOf(base));
  // New paragraphs on either side get ids that none of the three documents has, and that the two sides don't share.
  const used = new Set([base, mine, theirs].flatMap((d) => paragraphsIn(d.body).map((p) => p.attrs['w14:paraId']?.toUpperCase())));
  let next = 1;
  const newId = () => {
    while (used.has(formatId(next))) next++;
    const id = formatId(next++);
    used.add(id);
    return id;
  };
  const ours = diffDocuments(base, mine, newId);
  const other = diffDocuments(base, theirs, newId);
  if (!ours || !other) return null;
  const a = footprint(ours.ops);
  const b = footprint(other.ops);
  if (!a || !b || !separate(a, b)) return null;
  const merged = applied(base, other.ops, ours.ops);
  const check = applied(base, ours.ops, other.ops);
  if (!merged || !check || !sameBody(merged, check)) return null;
  return withParts(merged, parts);
}

/** The parts of a document besides its body, lists and comments. */
interface Parts {
  styles: WordDocument['styles'];
  section: WordDocument['section'];
  settings: WordDocument['settings'];
  properties: WordDocument['properties'];
  headersFooters: WordDocument['headersFooters'];
}

const partsOf = (doc: WordDocument): Parts => ({ styles: doc.styles, section: doc.section, settings: doc.settings, properties: doc.properties, headersFooters: doc.headersFooters });

/** A copy of `doc` (its body and lists its own) with these parts. */
function withParts(doc: WordDocument, parts: Parts): WordDocument {
  return Object.assign(copyDocument(doc), parts);
}

/** File › Properties a save stamps on its own (each writer, every time): taken from whichever side saved last, never a conflict. */
const SAVE_STAMPS = new Set(['modified', 'lastModifiedBy']);

/** File › Properties field by field, from the side that changed each; null when both changed one differently. */
function mergeProperties(base: WordDocument['properties'], mine: WordDocument['properties'], theirs: WordDocument['properties']): WordDocument['properties'] | null {
  const later = (theirs.modified ?? '') > (mine.modified ?? '') ? theirs : mine;
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]) as Set<keyof WordDocument['properties']>) {
    const [b, m, t] = [base[key], mine[key], theirs[key]];
    const value = SAVE_STAMPS.has(key) ? later[key] : m === t || t === b ? m : m === b ? t : null;
    if (value === null) return null;
    if (value !== undefined) out[key] = value;
  }
  return out as WordDocument['properties'];
}

/** Each part from the side that changed it; null when both changed one differently. */
function mergeParts(base: WordDocument, mine: WordDocument, theirs: WordDocument): Parts | null {
  const out = partsOf(base);
  const key = (doc: WordDocument, part: keyof Parts) => canonical(part === 'headersFooters' ? [...doc.headersFooters] : doc[part]);
  const properties = mergeProperties(base.properties, mine.properties, theirs.properties);
  if (!properties) return null;
  for (const part of Object.keys(out) as (keyof Parts)[]) {
    if (part === 'properties') {
      out.properties = properties;
      continue;
    }
    const [b, m, t] = [key(base, part), key(mine, part), key(theirs, part)];
    if (m === t || t === b) (out as unknown as Record<string, unknown>)[part] = mine[part];
    else if (m === b) (out as unknown as Record<string, unknown>)[part] = theirs[part];
    else return null;
  }
  return out;
}
