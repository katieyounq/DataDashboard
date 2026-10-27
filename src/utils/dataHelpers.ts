import type { DataRow } from "./csvParser";

export interface AxisRange {
  min: number;
  max: number;
}

export function computeYRange(points: DataRow[], column: keyof DataRow = "col6"): AxisRange {
  if (points.length === 0) return { min: 0, max: 1 };

  let min = Infinity;
  let max = -Infinity;

  for (const p of points) {
    const val = p[column] as number;
    if (val < min) min = val;
    if (val > max) max = val;
  }

  const padding = (max - min) * 0.05 || 0.01;
  return { min: min - padding, max: max + padding };
}

export interface EventSegment {
  eventCounter: number;
  startIndex: number;
  endIndex: number;
}

export function getEventSegments(points: DataRow[]): EventSegment[] {
  if (points.length === 0) return [];

  const segments: EventSegment[] = [];
  let currentEvent = points[0].eventCounter;
  let startIdx = 0;

  for (let i = 1; i < points.length; i++) {
    if (points[i].eventCounter !== currentEvent) {
      segments.push({
        eventCounter: currentEvent,
        startIndex: startIdx,
        endIndex: i - 1,
      });
      currentEvent = points[i].eventCounter;
      startIdx = i;
    }
  }

  segments.push({
    eventCounter: currentEvent,
    startIndex: startIdx,
    endIndex: points.length - 1,
  });

  return segments;
}

export function getUniqueEvents(points: DataRow[]): number[] {
  const events = new Set<number>();
  for (const p of points) {
    events.add(p.eventCounter);
  }
  return Array.from(events).sort((a, b) => a - b);
}

export const ADC_TOKENS = [
  "ADC01 (V)", "ADC02 (V)", "ADC03 (V)", "ADC04 (V)",
  "ADC05 (V)", "ADC06 (V)", "ADC07 (V)", "ADC08 (V)",
  "ADC09 (V)", "ADC10 (V)", "ADC11 (V)", "ADC12 (V)",
];

export const DIFF_TOKENS = [
  "DIFF01 (V)", "DIFF02 (V)", "DIFF03 (V)", "DIFF04 (V)",
  "DIFF05 (V)", "DIFF06 (V)", "DIFF07 (V)", "DIFF08 (V)",
  "DIFF09 (V)", "DIFF10 (V)", "DIFF11 (V)", "DIFF12 (V)",
];

export const TOKEN_GROUPS: Record<string, string[]> = {
  "ADC (V)": ADC_TOKENS,
  "DIFF (V)": DIFF_TOKENS,
  "Other": ["TEMP", "CURR (A)", "REF A (V)", "REF B (V)", "DAC F (V)"],
};

export function getTokenLabel(token: string): string {
  return token.replace(" (V)", "").replace("      ", "").trim();
}
