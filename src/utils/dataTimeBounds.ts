import type { DataRow } from "./csvParser";

/** Elapsed milliseconds since session start for a data point. */
export function elapsedMs(p: DataRow): number {
  return p.elapsedSeconds * 1000;
}

export function getDataTimeBounds(map: Map<string, DataRow[]>): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const pts of map.values()) {
    for (const p of pts) {
      const t = elapsedMs(p);
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
  if (max === min) return { min, max: min + 1 };
  return { min, max };
}

/** Format elapsed milliseconds as H:MM:SS or H:MM:SS.mmm */
export function formatElapsed(ms: number, showMs = false): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const base = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  if (!showMs) return base;
  const frac = Math.floor(ms % 1000);
  return `${base}.${String(frac).padStart(3, "0")}`;
}
