import type { DataRow } from "./csvParser";
import { getEventColor } from "./csvParser";

/**
 * Live / uploaded DataConfig.csv rows — only the first columns are used
 * (matches `DataConfig.csv`: startTime, eventCounter, wellSelect, eventName, …).
 * Example path (reference): `/Users/katie/Downloads/data/DataConfig.csv`
 */
export interface DataConfigRowParsed {
  startTimeMs: number;
  eventCounter: number;
  eventName: string;
  heartbeatMagnitude?: number;
  /** dacForce voltage per column (1-6), from DataConfig columns dacForce1..dacForce6. */
  dacForceVolts?: number[];
}

/** Distinct colors for human-readable event names (not tied to numeric counter). */
const NAME_COLOR_PALETTE = [
  "#2563eb", "#dc2626", "#16a34a", "#ca8a04", "#9333ea", "#db2777", "#0891b2", "#ea580c",
  "#4f46e5", "#0d9488", "#b45309", "#be123c", "#7c3aed", "#15803d", "#c026d3", "#0369a1",
  "#b91c1c", "#65a30d", "#a21caf", "#0e7490", "#c2410c", "#4338ca", "#047857", "#9f1239",
  "#6d28d9", "#0f766e", "#b45309", "#1d4ed8", "#15803d", "#be185d", "#7e22ce",
];

export function colorForEventName(name: string): string {
  const n = name.trim();
  if (!n) return "#64748b";
  let h = 2166136261;
  for (let i = 0; i < n.length; i++) {
    h ^= n.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return NAME_COLOR_PALETTE[Math.abs(h) % NAME_COLOR_PALETTE.length];
}

export function parseDataConfigStartTimeMs(cell: string): number | null {
  const raw = (cell || "").trim().split("\t")[0];
  const [datePart, timePart] = raw.split(/\s+/);
  if (!datePart || !timePart) return null;
  const [month, day, year] = datePart.split("/");
  const [hours, minutes, secMs] = timePart.split(":");
  if (!month || !day || !year || hours === undefined || minutes === undefined) return null;
  const [seconds, ms] = (secMs || "0").split(".");
  const t = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
    ms ? Number(ms) : 0
  ).getTime();
  return Number.isFinite(t) ? t : null;
}

const rowDedupeKey = (r: DataConfigRowParsed) =>
  `${r.startTimeMs}\t${r.eventCounter}\t${r.eventName}`;

/** Append server-poll rows; skips exact duplicates. Keeps sorted by time then counter. */
/**
 * Drop config rows far outside the current dataset’s time span so a cumulative DataConfig.csv
 * does not pair old sessions’ (eventCounter, name) rows with the run you have loaded.
 */
export function scopeDataConfigEntriesToDataRange(
  entries: readonly DataConfigRowParsed[],
  range: { min: number; max: number } | null,
  padMs = 14 * 24 * 60 * 60 * 1000
): DataConfigRowParsed[] {
  if (!entries.length) return [];
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return [...entries];
  const lo = range.min - padMs;
  const hi = range.max + padMs;
  const scoped = entries.filter((e) => e.startTimeMs >= lo && e.startTimeMs <= hi);
  return scoped.length ? scoped : [...entries];
}

export function mergeDataConfigRows(
  prev: DataConfigRowParsed[],
  incoming: DataConfigRowParsed[]
): DataConfigRowParsed[] {
  if (!incoming.length) return prev;
  const seen = new Set(prev.map(rowDedupeKey));
  const add = incoming.filter((r) => !seen.has(rowDedupeKey(r)));
  if (!add.length) return prev;
  return [...prev, ...add].sort(
    (a, b) => a.startTimeMs - b.startTimeMs || a.eventCounter - b.eventCounter
  );
}

/** Column indices in DataConfig.csv (0-based). */
const DCOL_HEARTBEAT_MAG = 33;
const DCOL_DAC_FORCE_START = 34;
const DCOL_DAC_FORCE_END = 39;

/** Parse one body line; returns null for header or invalid. */
export function parseDataConfigCsvLine(line: string): DataConfigRowParsed | null {
  const cols = line.split("\t");
  if (cols.length < 4) return null;
  const c0 = cols[0].trim();
  if (/^starttime$/i.test(c0)) return null;
  const startTimeMs = parseDataConfigStartTimeMs(cols[0]);
  if (startTimeMs === null) return null;
  const eventCounter = Number(cols[1]);
  if (!Number.isFinite(eventCounter)) return null;
  const eventName = String(cols[3] ?? "").trim();

  let heartbeatMagnitude: number | undefined;
  if (cols.length > DCOL_HEARTBEAT_MAG) {
    const v = parseFloat(cols[DCOL_HEARTBEAT_MAG]);
    if (Number.isFinite(v) && v > 0) heartbeatMagnitude = v;
  }

  let dacForceVolts: number[] | undefined;
  if (cols.length > DCOL_DAC_FORCE_END) {
    dacForceVolts = [];
    for (let i = DCOL_DAC_FORCE_START; i <= DCOL_DAC_FORCE_END; i++) {
      const v = parseFloat(cols[i]);
      dacForceVolts.push(Number.isFinite(v) ? v : 0);
    }
  }

  return {
    startTimeMs,
    eventCounter,
    eventName: eventName || `Event ${eventCounter}`,
    heartbeatMagnitude,
    dacForceVolts,
  };
}

export function parseDataConfigCsvText(text: string): DataConfigRowParsed[] {
  const out: DataConfigRowParsed[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = parseDataConfigCsvLine(line);
    if (row) out.push(row);
  }
  out.sort((a, b) => a.startTimeMs - b.startTimeMs || a.eventCounter - b.eventCounter);
  return out;
}

/**
 * Label from DataConfig for this data timestamp and counter:
 * most recent config row with same eventCounter and startTime <= dataTimestamp.
 */
export function resolveDataConfigEventName(
  dataTimestampMs: number,
  eventCounter: number,
  entries: readonly DataConfigRowParsed[]
): string | null {
  if (!entries.length) return null;
  let best: DataConfigRowParsed | null = null;
  for (const e of entries) {
    if (e.eventCounter !== eventCounter) continue;
    if (e.startTimeMs > dataTimestampMs) continue;
    if (!best || e.startTimeMs >= best.startTimeMs) best = e;
  }
  return best?.eventName ?? null;
}

export interface ResolvedEventVisual {
  caption: string;
  color: string;
}

/** Resolve event name by counter alone (ignores timestamp). Uses latest config entry for that counter. */
export function resolveEventVisualByCounter(
  eventCounter: number,
  streamEventLabels: Map<number, string>,
  dataConfigEntries: readonly DataConfigRowParsed[]
): ResolvedEventVisual {
  let best: DataConfigRowParsed | null = null;
  for (const e of dataConfigEntries) {
    if (e.eventCounter !== eventCounter) continue;
    if (!best || e.startTimeMs >= best.startTimeMs) best = e;
  }
  if (best) {
    return {
      caption: `${eventCounter} – ${best.eventName}`,
      color: colorForEventName(best.eventName),
    };
  }
  const fromStream = streamEventLabels.get(eventCounter)?.trim();
  if (fromStream) {
    return {
      caption: `${eventCounter} – ${fromStream}`,
      color: colorForEventName(fromStream),
    };
  }
  return {
    caption: `Event ${eventCounter}`,
    color: getEventColor(eventCounter),
  };
}

/** Caption + color for charts and legend (DataConfig wins on time+counter, else stream labels). */
export function resolveEventVisual(
  dataTimestampMs: number,
  eventCounter: number,
  streamEventLabels: Map<number, string>,
  dataConfigEntries: readonly DataConfigRowParsed[]
): ResolvedEventVisual {
  const fromCfg = resolveDataConfigEventName(dataTimestampMs, eventCounter, dataConfigEntries);
  if (fromCfg) {
    return {
      caption: `${eventCounter} – ${fromCfg}`,
      color: colorForEventName(fromCfg),
    };
  }
  const fromStream = streamEventLabels.get(eventCounter)?.trim();
  if (fromStream) {
    return {
      caption: `${eventCounter} – ${fromStream}`,
      color: colorForEventName(fromStream),
    };
  }
  return {
    caption: `Event ${eventCounter}`,
    color: getEventColor(eventCounter),
  };
}

/** Resolve heartbeat magnitude for an event (latest config entry wins). */
export function resolveHeartbeatMagnitude(
  eventCounter: number,
  dataTimestampMs: number,
  entries: readonly DataConfigRowParsed[]
): number | null {
  let best: DataConfigRowParsed | null = null;
  for (const e of entries) {
    if (e.eventCounter !== eventCounter) continue;
    if (e.startTimeMs > dataTimestampMs) continue;
    if (!best || e.startTimeMs >= best.startTimeMs) best = e;
  }
  return best?.heartbeatMagnitude ?? null;
}

/** Resolve heartbeat magnitude for an event by counter alone (latest entry). */
export function resolveHeartbeatMagnitudeByCounter(
  eventCounter: number,
  entries: readonly DataConfigRowParsed[]
): number | null {
  let best: DataConfigRowParsed | null = null;
  for (const e of entries) {
    if (e.eventCounter !== eventCounter) continue;
    if (!best || e.startTimeMs >= best.startTimeMs) best = e;
  }
  return best?.heartbeatMagnitude ?? null;
}

/** Latest data timestamp per event counter in the current window (for legend alignment). */
export function buildEventLatestTimestamps(tokenMap: Map<string, DataRow[]>): Map<number, number> {
  const m = new Map<number, number>();
  for (const pts of tokenMap.values()) {
    for (const p of pts) {
      const prev = m.get(p.eventCounter);
      if (prev === undefined || p.timestamp >= prev) {
        m.set(p.eventCounter, p.timestamp);
      }
    }
  }
  return m;
}
