// What an ai app working in the vault folder is told about Golem Docs (docs/architecture/desktop.md, "Instructions for ai apps").
//
// The app keeps its own guide in `.golemdocs/AGENTS.md`: written by the app, rewritten when a newer app has a newer guide, and
// never synced (the sync skips dot-names), so it is not a document in anyone's account. Agents read the instruction file at the
// top of the folder, not files in a dot-folder, so the person may add one line to theirs pointing at the guide. Most agents read
// `AGENTS.md`; Claude Code reads `CLAUDE.md` instead when there is one, and Gemini CLI reads `GEMINI.md`, so the line goes in
// each of those that is there, and only with the person's say-so: those files are theirs.

/** Where the app's guide is kept, inside the folder's state folder. */
export const GUIDE_PATH = '.golemdocs/AGENTS.md';

/** The instruction files at the top of the folder that agents read, the most widely read first. */
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;

/** Raise when the guide's text changes, so folders get the new one (an older app never overwrites a newer guide). */
export const GUIDE_VERSION = 1;

const MARKER = /^<!-- golemdocs-guide (\d+) -->/;

/** The folder the guide is for, read and written through the vault bridge (paths relative to the vault). */
export interface GuideDisk {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<unknown>;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function readText(disk: GuideDisk, path: string): Promise<string | null> {
  try {
    return decode(await disk.read(path));
  } catch {
    return null; // not there (or unreadable, which is treated the same: nothing is overwritten that couldn't be read)
  }
}

/** The guide, for agents (in English, the language they all read; it is never shown in the app). */
export function guideText(): string {
  return `<!-- golemdocs-guide ${GUIDE_VERSION} -->
<!-- Written by Golem Docs. It is replaced when the app updates, so don't edit it: put your own instructions in AGENTS.md (or CLAUDE.md) at the top of the folder. -->

# This folder is a Golem Docs vault

Every file here is a document in Golem Docs, the document editor the person uses. The app keeps this folder and their
documents in step both ways, so a change you make to a file reaches their Golem Docs, their other devices and anyone they
share the document with, within seconds. There is no special API: read and write the files as they are.

## Editing files

- **Files stay in their real format.** Edit a \`.docx\` as a Word file (python-docx, pandoc, a library you like), a \`.md\` or
  \`.txt\` as text, a \`.csv\` as CSV, an \`.svg\` as SVG. A Word file is kept byte for byte, so its formatting survives.
- **Markdown** may use \`[[Note]]\`, \`[[Note#Heading]]\`, \`[[Note|label]]\` and \`![[embed]]\` links between notes; Golem Docs
  shows them as links and keeps them right when a note is moved or renamed. Leave \`<!-- golem:live ... -->\` comments and
  what is between a pair of them alone: they are live blocks the app fills in itself.
- **PDFs** are written with their annotations, form fields and edits in them. A PDF you change replaces the document, and
  the old one's notes and edits go with it (the earlier version is kept in its history).
- **Pictures** (PNG, JPEG, WebP) are written with their layers drawn in. Changing one replaces the document with the flat
  picture, as for a PDF.
- **Renaming a file to another extension** saves the document again in that format.
- **Names starting with a dot are not documents**: \`.git\`, or a \`.scratch/\` folder for your own working files, stay
  private to this computer. So do names no format reads (a \`.zip\`, a file with no extension).

## What the sync does

- **The file wins.** When a file here changed, it replaces the document. If the document was changed in the app too, the
  app's version is kept in the document's history first, so nothing is lost.
- **Earlier versions are kept** before each burst of changes, and every ten minutes while changes go on.
- **Moving or renaming a file** keeps it the same document, with its history. Folders here are folders in the app.
- **Encrypted documents and folders are not here.** The person keeps them locked with a key of their own, and they never
  come to this folder, so you can't read or change what is in them.
- **Deleting a file** sends the document to the trash for 30 days.
- **If ten or more files vanish at once**, the sync stops and asks the person, because that is usually a drive that isn't
  there. Don't delete or move many files at once without telling them.
- The folder is looked at every 4 seconds while the app is open. When it is closed, changes are synced the next time it opens.

## Showing the person a note (Mac app)

To bring a note up in Golem Docs, open a link to it:

\`\`\`
open "golemdocs://open?file=<path in the folder>&heading=<heading>"
\`\`\`

Percent-encode each value. \`heading\` (any case, or a \`#github-style-anchor\`) and \`line=<n>\` (counting from 1) are
optional. File › Copy Link to Note in the app copies such a link for the note the person has open.

## Don't

- Don't touch \`.golemdocs/\` (apart from reading this file): it holds the sync state.
- Don't make copies of a note to keep an old version: the history already has it.
`;
}

/** The guide's version written in its first line, or null for a file that has none. */
export function guideVersion(text: string): number | null {
  const match = MARKER.exec(text);
  return match ? Number(match[1]) : null;
}

/** Writes the guide when it is missing, older, or not as written (a newer app's guide is left as it is). Returns whether it wrote. */
export async function writeGuide(disk: GuideDisk): Promise<boolean> {
  const wanted = guideText();
  const existing = await readText(disk, GUIDE_PATH);
  if (existing === wanted) return false;
  const version = existing === null ? null : guideVersion(existing);
  if (version !== null && version > GUIDE_VERSION) return false;
  await disk.write(GUIDE_PATH, encode(wanted));
  return true;
}

/** Whether an instruction file already sends agents to the guide (in any language: the path is what is looked for). */
export const pointsToGuide = (text: string): boolean => text.includes(GUIDE_PATH);

/** The instruction files at the top of the folder: those there, and of them those that don't point to the guide yet. */
export interface PointerState {
  present: string[];
  missing: string[];
}

export async function pointerState(disk: GuideDisk): Promise<PointerState> {
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    const text = await readText(disk, name);
    if (text === null) continue;
    present.push(name);
    if (!pointsToGuide(text)) missing.push(name);
  }
  return { present, missing };
}

/** `text` with `line` added as a paragraph of its own at the end. */
export function withPointer(text: string, line: string): string {
  if (pointsToGuide(text)) return text;
  const body = text.replace(/\s+$/, '');
  return body ? `${body}\n\n${line}\n` : `${line}\n`;
}

/**
 * Adds `line` (which names `GUIDE_PATH`) to each instruction file that lacks it, or, when the folder has none, makes an
 * `AGENTS.md` with `heading` and the line. Returns the files it wrote.
 */
export async function addPointers(disk: GuideDisk, line: string, heading: string): Promise<string[]> {
  if (!pointsToGuide(line)) throw new Error(`the line must name ${GUIDE_PATH}`);
  const { present, missing } = await pointerState(disk);
  if (!present.length) {
    await disk.write('AGENTS.md', encode(`# ${heading}\n\n${line}\n`));
    return ['AGENTS.md'];
  }
  for (const name of missing) {
    const text = (await readText(disk, name)) ?? '';
    await disk.write(name, encode(withPointer(text, line)));
  }
  return missing;
}
