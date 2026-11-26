// Puts a list back where it was scrolled to before a reload. Its rows often arrive a little at a
// time (what this browser has, then the account's listing), so the saved position is held until
// the list is tall enough to reach it, and let go of as soon as the person scrolls it themselves.

/** What of an element is read and set; a plain object in tests. */
export interface Scrollable {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export class ScrollRestore {
  private target: number | null;

  constructor(target: number | null) {
    this.target = target !== null && Number.isFinite(target) && target > 0 ? target : null;
  }

  /** Still waiting to put the list back (so its scrolling is not the person's, and is not saved). */
  get pending(): boolean {
    return this.target !== null;
  }

  /** Scrolls `el` to the saved position once it can reach all of it; true when that is done. */
  apply(el: Scrollable): boolean {
    if (this.target === null) return false;
    if (el.clientHeight <= 0 || el.scrollHeight - el.clientHeight < this.target) return false;
    el.scrollTop = this.target;
    this.target = null;
    return true;
  }

  /** The person scrolled or clicked: what they did wins over the saved position. */
  cancel(): void {
    this.target = null;
  }
}

/** The sidebar's place, kept in this browser: Trash or the documents, and how far each is scrolled. */
export interface FilesView {
  trash: boolean;
  treeScroll: number;
  trashScroll: number;
}

export function parseFilesView(text: string | null): FilesView {
  const view: FilesView = { trash: false, treeScroll: 0, trashScroll: 0 };
  if (!text) return view;
  try {
    const saved = JSON.parse(text) as Partial<FilesView> | null;
    if (saved && typeof saved === 'object') {
      if (typeof saved.trash === 'boolean') view.trash = saved.trash;
      if (typeof saved.treeScroll === 'number' && saved.treeScroll > 0) view.treeScroll = saved.treeScroll;
      if (typeof saved.trashScroll === 'number' && saved.trashScroll > 0) view.trashScroll = saved.trashScroll;
    }
  } catch {
    // Not ours, or damaged: start at the top.
  }
  return view;
}
