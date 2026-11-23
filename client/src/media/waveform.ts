// An audio file's waveform: the loudest sample in each of a few thousand slices, drawn as bars the played part of which is coloured.

/** The peak (0 to 1) of each of `buckets` equal slices of the sound, over every channel. */
export function wavePeaks(channels: readonly Float32Array[], buckets: number): Float32Array {
  const length = channels[0]?.length ?? 0;
  const count = Math.max(1, Math.min(buckets, length || 1));
  const peaks = new Float32Array(count);
  if (!length) return peaks;
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * length) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * length) / count));
    let peak = 0;
    for (const channel of channels) {
      for (let i = from; i < to; i++) {
        const v = Math.abs(channel[i]!);
        if (v > peak) peak = v;
      }
    }
    peaks[b] = Math.min(1, peak);
  }
  return peaks;
}

/** The peaks to draw in `columns` columns: the loudest of the peaks each column covers. */
export function columnPeaks(peaks: Float32Array, columns: number): Float32Array {
  const out = new Float32Array(Math.max(0, columns));
  for (let c = 0; c < columns; c++) {
    const from = Math.floor((c * peaks.length) / columns);
    const to = Math.max(from + 1, Math.floor(((c + 1) * peaks.length) / columns));
    let peak = 0;
    for (let i = from; i < to && i < peaks.length; i++) peak = Math.max(peak, peaks[i]!);
    out[c] = peak;
  }
  return out;
}

/**
 * Draws the waveform across the canvas, the part before `played` (0 to 1) in the played colour and a line where it is. With no
 * peaks (a long file, or one that couldn't be decoded), a plain bar shows how far it has played.
 */
export function drawWave(context: CanvasRenderingContext2D, peaks: Float32Array | null, played: number, colors: { wave: string; played: string; head: string }, scale: number): void {
  const { width, height } = context.canvas;
  context.clearRect(0, 0, width, height);
  const middle = height / 2;
  const split = Math.round(width * Math.max(0, Math.min(1, played)));
  if (!peaks) {
    const bar = Math.max(2, Math.round(4 * scale));
    context.fillStyle = colors.wave;
    context.fillRect(0, middle - bar / 2, width, bar);
    context.fillStyle = colors.played;
    context.fillRect(0, middle - bar / 2, split, bar);
  } else {
    const step = Math.max(2, Math.round(3 * scale));
    const columns = Math.floor(width / step);
    const tops = columnPeaks(peaks, columns);
    const barWidth = Math.max(1, step - Math.max(1, Math.round(scale)));
    for (let c = 0; c < columns; c++) {
      const half = Math.max(scale, tops[c]! * (middle - scale));
      context.fillStyle = c * step < split ? colors.played : colors.wave;
      context.fillRect(c * step, middle - half, barWidth, half * 2);
    }
  }
  if (played > 0 && colors.head !== 'transparent') {
    context.fillStyle = colors.head;
    context.fillRect(Math.min(width - scale, split), 0, Math.max(1, scale), height);
  }
}
