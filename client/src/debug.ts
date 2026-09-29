// Debug flags: what the on-screen debug overlays show: document status, and render information. They belong to this browser (kept in
// localStorage), not the document, and are all off until switched on in View > Debug.

/** The overlay a flag belongs to. */
export type DebugPanel = 'Document' | 'Render';

export const DEBUG_FLAGS = [
  { key: 'status', panel: 'Document', label: 'Status', hint: 'Sync and collaboration status, and how long the last edit took to reach the screen' },
  { key: 'pages', panel: 'Render', label: 'Pages and glyphs', hint: 'Pages visible, glyphs drawn and draw calls per frame' },
  { key: 'zoom', panel: 'Render', label: 'Zoom', hint: 'The current zoom level' },
  { key: 'cpu', panel: 'Render', label: 'CPU time', hint: 'How long the last frame took to submit to the GPU' },
  { key: 'fps', panel: 'Render', label: 'FPS and render light', hint: 'Frame rate of the last stretch of drawing (it holds there while the canvas is idle: it only draws on demand), beside a light that flashes whenever the canvas draws' },
  { key: 'frameTimes', panel: 'Render', label: 'Slowest and dropped frames', hint: 'Slowest frame, longest gap between frames while scrolling or animating, and frames missed. Click the overlay to reset' },
] as const satisfies readonly { key: string; panel: DebugPanel; label: string; hint: string }[];

export type DebugFlag = (typeof DEBUG_FLAGS)[number]['key'];
export type DebugFlags = Record<DebugFlag, boolean>;

const STORAGE_KEY = 'golem.debug';

const OFF = Object.fromEntries(DEBUG_FLAGS.map((f) => [f.key, false])) as DebugFlags;

/** The saved flags; anything missing, unknown or unreadable is off. */
export function loadDebugFlags(): DebugFlags {
  const flags = { ...OFF };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') for (const { key } of DEBUG_FLAGS) flags[key] = (saved as Record<string, unknown>)[key] === true;
  } catch {
    // Storage unavailable or corrupt: everything stays off.
  }
  return flags;
}

function saveDebugFlags(flags: DebugFlags): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch {
    // Storage unavailable (private window, blocked): the flags last for this session only.
  }
}

let current = loadDebugFlags();
const listeners = new Set<() => void>();

export function debugFlags(): Readonly<DebugFlags> {
  return current;
}

export function setDebugFlag(key: DebugFlag, on: boolean): void {
  if (current[key] === on) return;
  current = { ...current, [key]: on };
  saveDebugFlags(current);
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever a flag changes. Returns the way to stop. */
export function onDebugFlagsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// --- Frame timing ---------------------------------------------------------------------------

/** Frames further apart than this aren't part of one continuous run (scrolling, animating). */
const RUN_GAP_MS = 250;
/** The shortest display refresh interval taken as real; shorter gaps are extra draws in one frame. */
const MIN_REFRESH_MS = 6;
/** How many recent gaps between frames the frame rate is averaged over. */
const RATE_GAPS = 30;

/**
 * Times the canvas's draws. It draws on demand, so a gap between two frames is only a dropped
 * frame if they're part of one run: a second of idle isn't a hundred missed frames.
 */
export class FrameMonitor {
  /** The recent gaps between frames in the current run, ms (newest last). */
  private gaps: number[] = [];
  private last = 0;
  /** The display's frame interval, learned from the shortest gap seen in a run (60 Hz to start). */
  private refresh = 1000 / 60;
  /** Frames per second over the latest run; it holds there while nothing draws. */
  rate = 0;
  /** The most recent frame's CPU time, ms. */
  cpuMs = 0;
  /** The slowest frame's CPU time since reset, ms. */
  maxCpuMs = 0;
  /** The longest gap between two frames in a run since reset, ms. */
  maxGapMs = 0;
  /** Frames missed within runs since reset. */
  dropped = 0;

  /** Records a frame drawn at `now` that took `cpuMs` (both from performance.now()). */
  record(now: number, cpuMs: number): void {
    this.cpuMs = cpuMs;
    if (cpuMs > this.maxCpuMs) this.maxCpuMs = cpuMs;
    if (this.last) {
      const gap = now - this.last;
      if (gap < RUN_GAP_MS) {
        if (gap >= MIN_REFRESH_MS && gap < this.refresh) this.refresh = gap;
        if (gap > this.maxGapMs) this.maxGapMs = gap;
        if (gap > this.refresh * 1.5) this.dropped += Math.round(gap / this.refresh) - 1;
        // (Two draws inside one display frame aren't a rate.)
        if (gap >= MIN_REFRESH_MS) {
          this.gaps.push(gap);
          if (this.gaps.length > RATE_GAPS) this.gaps.shift();
          this.rate = (1000 * this.gaps.length) / this.gaps.reduce((a, b) => a + b, 0);
        }
      } else {
        // A new run: its rate replaces the last one's once it has a gap to go on.
        this.gaps.length = 0;
      }
    }
    this.last = now;
  }

  /** Forgets the slowest frame, longest gap and dropped frames. */
  clear(): void {
    this.maxCpuMs = 0;
    this.maxGapMs = 0;
    this.dropped = 0;
  }
}
