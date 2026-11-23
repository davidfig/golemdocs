// A view-only page's live line (share.ts, folderPage.ts): a WebSocket to the document's room, which says `saved` each time a newer
// version of the file goes in (the server's room.ts calls the page a listener). The page then checks for the newer file at once,
// rather than at its next look every half minute, so it follows the edits within a moment of each save. The line carries no part of
// the document, only that it changed; the page still fetches the file as before (and still checks every so often, which is how it
// hears that access ended when nobody closed the line).
//
// When the line drops (the network, a deploy, access withdrawn, the link reset) the page checks at once, which tells it whether it
// may still see the document, and the line is opened again after a pause that grows while it keeps failing. A server without rooms
// refuses it every time: the page then just checks as it always did.

/** The first pause before opening a dropped line again, and the longest. */
export const RETRY_MIN_MS = 2_000;
export const RETRY_MAX_MS = 60_000;

export interface LiveLine {
  /** Closes it for good (the page let the document go, or shows another file). */
  stop(): void;
}

/** What the line uses from the browser, handed in so tests can stand in for it. */
export interface LiveDeps {
  /** A WebSocket to this site's `path`. */
  open(path: string): Pick<WebSocket, 'onopen' | 'onmessage' | 'onclose' | 'close'>;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const browser = (): LiveDeps => ({
  open: (path) => new WebSocket(socketUrl(path)),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
});

/** The ws: or wss: address of a path on this site. */
export const socketUrl = (path: string, here: { protocol: string; host: string } = location): string => `${here.protocol === 'https:' ? 'wss' : 'ws'}://${here.host}${path}`;

/** Opens the live line at `path` (`/api/view/<token>/live` and the like); `changed` runs on each save, and whenever the line drops. */
export function followSaves(path: string, changed: () => void, deps: LiveDeps = browser()): LiveLine {
  let stopped = false;
  let socket: ReturnType<LiveDeps['open']> | null = null;
  let timer = 0;
  let pause = RETRY_MIN_MS;

  const retry = (): void => {
    if (stopped) return;
    timer = deps.setTimeout(connect, pause);
    pause = Math.min(pause * 2, RETRY_MAX_MS);
  };

  function connect(): void {
    timer = 0;
    if (stopped) return;
    try {
      socket = deps.open(path);
    } catch {
      return retry();
    }
    const mine = socket;
    mine.onopen = () => {
      pause = RETRY_MIN_MS;
    };
    mine.onmessage = (event: MessageEvent) => {
      try {
        if ((JSON.parse(String(event.data)) as { type?: string }).type === 'saved') changed();
      } catch {
        // Not a message the page knows: nothing to do.
      }
    };
    mine.onclose = () => {
      if (socket !== mine || stopped) return;
      socket = null;
      // A save may have gone in while it was down, or access may have ended: the check tells which.
      changed();
      retry();
    };
  }

  connect();
  return {
    stop() {
      stopped = true;
      if (timer) deps.clearTimeout(timer);
      const was = socket;
      socket = null;
      was?.close();
    },
  };
}
