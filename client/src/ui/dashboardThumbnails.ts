// The Documents screen's first-page pictures. Each is fetched only once its card scrolls into view:
// this device's copy when it has the current one, else the account's. One already loaded is put
// back when the cards are drawn again (the account's list arriving), rather than fetched again.

import { thumbnailUrl, type CloudDocument } from '../cloud.ts';
import { getThumbnail } from '../storage/local.ts';
import type { LibraryEntry } from '../sync.ts';
import { h } from './dom.ts';

export class Thumbnails {
  private observer: IntersectionObserver | null = null;
  private objectUrls: string[] = [];
  private readonly entryFor = new WeakMap<HTMLElement, LibraryEntry>();
  private readonly sharedFor = new WeakMap<HTMLElement, CloudDocument>();
  /** Pictures already on screen, so a redraw doesn't load them again. */
  private readonly loaded = new Map<string, { signature: string; img: HTMLImageElement }>();
  /** Bumped when the pictures are let go, so a load finishing after that is dropped. */
  private generation = 0;

  /** `scroller`: what the cards scroll in (a card near its edge counts as in view). */
  constructor(private readonly scroller: HTMLElement) {}

  /** An empty picture for a document's card (`key` tells it from the card's other pictures). */
  forEntry(entry: LibraryEntry, key = entry.key, className = 'wm-thumb'): HTMLElement {
    const thumb = h('div', { class: className }, h('div', { class: 'wm-thumb-empty', attrs: { 'aria-hidden': 'true' } }));
    this.entryFor.set(thumb, entry);
    this.reuse(thumb, key, signature(entry));
    return thumb;
  }

  /** An empty picture for a document someone shared. */
  forShared(doc: CloudDocument): HTMLElement {
    const thumb = h('div', { class: 'wm-thumb' }, h('div', { class: 'wm-thumb-empty', attrs: { 'aria-hidden': 'true' } }));
    this.sharedFor.set(thumb, doc);
    this.reuse(thumb, `shared:${doc.id}`, thumbnailUrl(doc) ?? '');
    return thumb;
  }

  /** The cards are about to be drawn again: stop watching the old ones. */
  pause(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** The cards are drawn: load each picture as it comes into view. */
  watch(): void {
    this.pause();
    this.observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          this.observer?.unobserve(record.target);
          void this.load(record.target as HTMLElement);
        }
      },
      { root: this.scroller, rootMargin: '200px' },
    );
    for (const el of this.scroller.querySelectorAll<HTMLElement>('.wm-thumb')) this.observer.observe(el);
  }

  /** The screen is closed: let go of every picture. */
  release(): void {
    this.pause();
    this.generation++;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
    this.loaded.clear();
  }

  /** Puts back the image a previous drawing already loaded for this card, if it is still current. */
  private reuse(thumb: HTMLElement, key: string, signature: string): void {
    thumb.dataset.thumbKey = key;
    thumb.dataset.thumbSignature = signature;
    const cached = this.loaded.get(key);
    if (cached?.signature === signature) {
      thumb.replaceChildren(cached.img);
      thumb.dataset.thumbDone = '1';
    }
  }

  /** Fills a card's picture: this device's when it has the current one, else the account's. */
  private async load(thumb: HTMLElement): Promise<void> {
    if (thumb.dataset.thumbDone) return;
    const shared = this.sharedFor.get(thumb);
    if (shared) return this.show(thumb, thumbnailUrl(shared));
    const entry = this.entryFor.get(thumb);
    if (!entry) return;
    const generation = this.generation;
    const cloudUrl = entry.cloud ? thumbnailUrl(entry.cloud) : null;
    let src: string | null = prefersCloud(entry) ? cloudUrl : null;
    if (!src && entry.local) {
      const local = await getThumbnail(entry.local.id).catch(() => null);
      if (generation !== this.generation) return;
      if (local) {
        src = URL.createObjectURL(local.blob);
        this.objectUrls.push(src);
      }
    }
    this.show(thumb, src ?? cloudUrl);
  }

  private show(thumb: HTMLElement, src: string | null): void {
    if (!src) return;
    const img = h('img', { attrs: { alt: '', decoding: 'async', draggable: 'false' } });
    img.addEventListener(
      'load',
      () => {
        thumb.replaceChildren(img);
        thumb.dataset.thumbDone = '1';
        const { thumbKey, thumbSignature } = thumb.dataset;
        if (thumbKey && thumbSignature !== undefined) this.loaded.set(thumbKey, { signature: thumbSignature, img });
      },
      { once: true },
    );
    img.src = src; // on failure the placeholder stays
  }
}

/** Whether the account's picture is the one to show: there is no copy here, or the account's is newer. */
const prefersCloud = (entry: LibraryEntry): boolean => !entry.local || entry.state === 'cloud-ahead';

/** What decides which image a card shows; when it is unchanged the loaded image is still right. */
function signature(entry: LibraryEntry): string {
  const cloudUrl = entry.cloud ? thumbnailUrl(entry.cloud) : null;
  return `${prefersCloud(entry) ? 'cloud' : 'local'}|${cloudUrl}|${entry.local?.id}|${entry.local?.updatedAt}`;
}
