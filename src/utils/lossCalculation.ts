import type { DataRow } from "./csvParser";

export interface LossResult {
  eventCounter: number;
  /** Mean ADC across all points in this event (sum / count). */
  avgOutput: number;
  avgHigh: number;
  avgLow: number;
  loss: number;
  heartbeatMagnitude: number;
  nHigh: number;
  nLow: number;
  nTotal: number;
}

/**
 * Return a CSS background-color for a loss-percentage cell.
 * The value is in "×100" form (e.g. 85 means 85 %).
 *
 * Gradient (continuous):
 *   ≥ 95  → bright green  #22c55e
 *   ≈ 85  → yellow        #eab308
 *   ≈ 75  → orange-red    #ef4444
 *   ≤ 70  → dark red      #991b1b
 */
export function lossHeatmapColor(lossPct: number): string {
  const stops: [number, [number, number, number]][] = [
    [70,  [153, 27, 27]],   // #991b1b
    [75,  [239, 68, 68]],   // #ef4444
    [85,  [234, 179, 8]],   // #eab308
    [95,  [34, 197, 94]],   // #22c55e
  ];

  if (lossPct <= stops[0][0]) return `rgb(${stops[0][1].join(",")})`;
  if (lossPct >= stops[stops.length - 1][0])
    return `rgb(${stops[stops.length - 1][1].join(",")})`;

  for (let i = 0; i < stops.length - 1; i++) {
    const [lo, cLo] = stops[i];
    const [hi, cHi] = stops[i + 1];
    if (lossPct >= lo && lossPct <= hi) {
      const t = (lossPct - lo) / (hi - lo);
      const r = Math.round(cLo[0] + (cHi[0] - cLo[0]) * t);
      const g = Math.round(cLo[1] + (cHi[1] - cLo[1]) * t);
      const b = Math.round(cLo[2] + (cHi[2] - cLo[2]) * t);
      return `rgb(${r},${g},${b})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(",")})`;
}

/** Foreground color for readability against a heatmap background. */
export function lossHeatmapTextColor(lossPct: number): string {
  return lossPct <= 72 ? "#fff" : "#000";
}

/**
 * Compute loss for a single ADC channel within one event.
 *
 * Loss = (Avg_high − Avg_low) / heartbeatMagnitude × 100
 *
 * where Avg_high is the mean ADC value when dacForce > 0,
 * and Avg_low is the mean ADC value when dacForce == 0.
 */
export function computeEventLoss(
  points: DataRow[],
  col: keyof DataRow,
  heartbeatMagnitude: number
): LossResult | null {
  if (points.length === 0 || heartbeatMagnitude <= 0) return null;

  let sumHigh = 0;
  let nHigh = 0;
  let sumLow = 0;
  let nLow = 0;

  for (const p of points) {
    const val = p[col] as number;
    if (!Number.isFinite(val)) continue;
    if (p.dacForce > 0) {
      sumHigh += val;
      nHigh++;
    } else {
      sumLow += val;
      nLow++;
    }
  }

  if (nHigh === 0 || nLow === 0) return null;

  const avgHigh = sumHigh / nHigh;
  const avgLow = sumLow / nLow;
  const nTotal = nHigh + nLow;
  const avgOutput = (sumHigh + sumLow) / nTotal;
  const loss = ((avgHigh - avgLow) / heartbeatMagnitude) * 100;

  return {
    eventCounter: points[0].eventCounter,
    avgOutput,
    avgHigh,
    avgLow,
    loss,
    heartbeatMagnitude,
    nHigh,
    nLow,
    nTotal,
  };
}

/**
 * Derive heartbeat magnitude from actual dacForce values in the data:
 * uses the mean non-zero dacForce value within the event.
 */
function deriveDacForceMagnitude(points: DataRow[]): number | null {
  let sum = 0;
  let n = 0;
  for (const p of points) {
    if (p.dacForce > 0) {
      sum += p.dacForce;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

/**
 * Compute loss for each event for a given ADC token's data points.
 *
 * @param adcPoints  All data points for one ADC token (e.g. ADC01)
 * @param col        The data column to read (e.g. "col6")
 * @param getHeartbeat  Function to resolve heartbeat magnitude for an event counter;
 *                      if it returns null, the actual dacForce voltage is used as fallback.
 * @returns Array of LossResult per event, sorted by event counter
 */
export function computeLossPerEvent(
  adcPoints: DataRow[],
  col: keyof DataRow,
  getHeartbeat: (eventCounter: number) => number | null
): LossResult[] {
  const byEvent = new Map<number, DataRow[]>();
  for (const p of adcPoints) {
    if (!byEvent.has(p.eventCounter)) byEvent.set(p.eventCounter, []);
    byEvent.get(p.eventCounter)!.push(p);
  }

  const results: LossResult[] = [];
  for (const [ec, pts] of byEvent) {
    let hb = getHeartbeat(ec);
    if (hb === null || hb <= 0) {
      hb = deriveDacForceMagnitude(pts);
    }
    if (hb === null || hb <= 0) continue;
    const r = computeEventLoss(pts, col, hb);
    if (r) results.push(r);
  }

  results.sort((a, b) => a.eventCounter - b.eventCounter);
  return results;
}
