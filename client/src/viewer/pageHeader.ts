// The header of the site's shared pages (share.ts for a document, folderPage.ts for a folder, and their messages in page.ts): the
// row the app's menu bar takes, so a shared page looks like Golem Docs and says it is. Golem Docs' mark and name at the start, linking
// home; the file's name in the middle, with its folder and "View only" (as the app shows its save state there); then who shared it
// (a share with a person only: a public link names nobody), and the visitor's way in: their picture, back to their documents, or
// Try Golem Docs if they are signed out. A shared folder adds its Files button and Download All. See docs/architecture/viewer.md.

import { t } from '../i18n/index.ts';
import { avatar } from '../ui/avatar.ts';
import { h } from '../ui/dom.ts';
import { fileIcon, setFileName } from '../ui/fileIcons.ts';

/** Who shared it, as the server says (`owner` on /api/view and /api/folder-view). */
export interface Sharer {
  name: string | null;
  picture: string | null;
}

export interface PageHeaderOptions {
  /** Before the title: a shared folder's Files button. */
  start?: Node[];
  /** After the note, before who shared it: Download All. */
  tools?: Node[];
}

/** How long a note in the header (a link that goes outside the folder, a print that went to Preview) stays. */
const NOTE_MS = 6000;

/** The open eye of "View only". */
const EYE = 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM10 8A2 2 0 1 1 6 8A2 2 0 1 1 10 8';

function eye(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', EYE);
  svg.append(path);
  return svg;
}

/** Golem Docs' mark and name, as a link (home for a visitor, their documents once signed in). */
export function brandLink(className = 'wm-viewer-brand'): HTMLAnchorElement {
  return h(
    'a',
    { class: className, attrs: { href: '/home' } },
    h('img', { attrs: { src: '/favicon.svg', alt: '', width: '16', height: '16' } }),
    h('span', { class: 'wm-viewer-brand-name', text: t('viewer.appName') }),
  );
}

/** Whoever is signed in on this browser (null for a visitor, or when the server can't be asked). */
async function signedIn(): Promise<{ name: string | null; picture: string | null } | null> {
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!response.ok) return null;
    const { user } = (await response.json()) as { user: { name?: string | null; email?: string | null; picture?: string | null } | null };
    return user ? { name: user.name ?? user.email ?? null, picture: user.picture ?? null } : null;
  } catch {
    return null;
  }
}

export class PageHeader {
  readonly el: HTMLElement;
  /** A note for the person (progress, a link that goes outside the folder): a live region, so screen readers hear it. */
  readonly note: HTMLElement;
  private readonly title = h('h1', { class: 'wm-viewer-heading' });
  private readonly sharer = h('span', { class: 'wm-viewer-sharer' });
  private readonly account = h('span', { class: 'wm-viewer-account' });
  private readonly brand = brandLink();

  constructor(options: PageHeaderOptions = {}) {
    this.note = h('span', { class: 'wm-find-message wm-viewer-note', attrs: { role: 'status' } });
    this.sharer.hidden = true;
    this.el = h(
      'header',
      { class: 'wm-viewer-header' },
      this.brand,
      ...(options.start?.length ? [h('span', { class: 'wm-viewer-divider' }), ...options.start] : []),
      h('div', { class: 'wm-viewer-middle' }, this.title),
      h('div', { class: 'wm-viewer-end' }, this.note, ...(options.tools ?? []), this.sharer, this.account),
    );
    // A visitor is offered the app until we know they are signed in.
    this.account.append(h('a', { class: 'wm-button wm-primary wm-viewer-try', text: t('viewer.tryGolemDocs'), attrs: { href: '/home' } }));
    void signedIn().then((me) => {
      if (!me) return;
      this.brand.setAttribute('href', '/');
      const label = t('viewer.yourDocuments');
      this.account.replaceChildren(h('a', { class: 'wm-viewer-me', title: label, attrs: { href: '/', 'aria-label': label } }, avatar(me.picture, me.name, 20)));
    });
  }

  /** The file shown, and the folder it is in (a shared folder's name); nothing before a file opens. */
  setTitle(name: string | null, folder?: string): void {
    if (!name) return void this.title.replaceChildren();
    this.title.replaceChildren(
      fileIcon(name),
      setFileName(h('span', { class: 'wm-viewer-filename', title: name }), name),
      ...(folder ? [h('span', { class: 'wm-viewer-in', text: t('viewer.inFolder', { folder }) })] : []),
      h('span', { class: 'wm-viewer-pill' }, eye() as unknown as Node, h('span', { text: t('viewer.viewOnly') })),
    );
  }

  private noteTimer = 0;
  /** Says `text` in the note for a few seconds; one that stays (`lasting`) is for progress, replaced by the next. */
  tell(text: string, lasting = false): void {
    clearTimeout(this.noteTimer);
    this.note.textContent = text;
    if (!lasting) this.noteTimer = window.setTimeout(() => (this.note.textContent = ''), NOTE_MS);
  }

  /** Who shared it (null: a public link, which names nobody). */
  setSharer(sharer: Sharer | null | undefined): void {
    this.sharer.hidden = !sharer?.name;
    if (!sharer?.name) return void this.sharer.replaceChildren();
    const text = t('viewer.sharedBy', { name: sharer.name });
    this.sharer.title = text;
    this.sharer.replaceChildren(avatar(sharer.picture, sharer.name, 20), h('span', { class: 'wm-viewer-sharer-name', text }));
  }
}
