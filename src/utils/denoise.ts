import type { DataRow } from "./csvParser";

export interface DenoiseParams {
  windowSize: number;    // rolling window size (default 21, must be odd)
  threshold: number;     // MAD threshold for spike detection (default 5.0)
}

/**
 * Default denoise parameters.
 *
 * The threshold is intentionally set to 6.0 MAD to be conservative: it removes
 * large random voltage spikes while preserving the small periodic "heartbeat"
 * signal (dacForce 0/1 toggling every few loops). Heartbeat deviations are
 * small and consistent, so they stay well below this threshold. The window
 * size of 21 spans multiple heartbeat cycles, ensuring the rolling median
 * captures the heartbeat baseline accurately rather than treating it as noise.
 */
export const DEFAULT_DENOISE_PARAMS: DenoiseParams = {
  windowSize: 21,
  threshold: 6.0,
};

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Denoise a single numeric array using median-based spike detection.
 * Returns a new array with spikes replaced by local medians.
 */
export function denoiseSignal(
  values: number[],
  params?: Partial<DenoiseParams>
): number[] {
  const { windowSize: rawWin, threshold } = { ...DEFAULT_DENOISE_PARAMS, ...params };
  const windowSize = rawWin % 2 === 0 ? rawWin + 1 : rawWin; // ensure odd
  const half = Math.floor(windowSize / 2);
  const n = values.length;
  if (n === 0) return [];

  const result = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    const window: number[] = [];
    for (let j = lo; j <= hi; j++) {
      window.push(values[j]);
    }

    const localMedian = median(window);

    // Compute MAD (Median Absolute Deviation)
    const deviations: number[] = [];
    for (let j = 0; j < window.length; j++) {
      deviations.push(Math.abs(window[j] - localMedian));
    }
    const mad = median(deviations);

    // Modified z-score: 0.6745 is the 0.75th quantile of the standard normal distribution
    // MAD * 1.4826 ≈ standard deviation for normal data
    const scaledMad = mad * 1.4826;

    if (scaledMad === 0) {
      // All values in window are identical (or nearly so); keep original
      result[i] = values[i];
    } else {
      const zScore = Math.abs(values[i] - localMedian) / scaledMad;
      result[i] = zScore > threshold ? localMedian : values[i];
    }
  }

  return result;
}

/**
 * Denoise DataRow arrays: for a given column, replace spike values with local medians.
 * Returns new DataRow objects (does not mutate originals).
 */
export function denoiseDataRows(
  rows: DataRow[],
  column: keyof DataRow,
  params?: Partial<DenoiseParams>
): DataRow[] {
  if (rows.length === 0) return [];

  const values = rows.map((r) => r[column] as number);
  const cleaned = denoiseSignal(values, params);

  return rows.map((row, i) => ({
    ...row,
    [column]: cleaned[i],
  }));
}
