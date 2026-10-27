import type { DataRow } from "./csvParser";

/**
 * Map mux loop index → REF value. If several REF rows share the same loopCounter,
 * the last one in array order wins (typical log: one REF row per loop).
 */
function refValueByLoopCounter(refPoints: DataRow[], refCol: keyof DataRow): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of refPoints) {
    m.set(p.loopCounter, p[refCol] as number);
  }
  return m;
}

/**
 * DAC force: (ADC / dacForceDivisor) − reference, paired by `loopCounter`.
 * ADC uses `adcCol` (default col6); divisor is DAC force; reference uses `refCol` on REF rows.
 */
export function deriveSingleEndedMinusRef(
  adcPoints: DataRow[],
  dacForceDivisor: number,
  refPoints: DataRow[],
  refCol: keyof DataRow,
  adcCol: keyof DataRow = "col6"
): DataRow[] {
  if (!Number.isFinite(dacForceDivisor) || dacForceDivisor <= 0) return [];
  const refByLoop = refValueByLoopCounter(refPoints, refCol);
  const out: DataRow[] = [];
  for (const p of adcPoints) {
    const refV = refByLoop.get(p.loopCounter);
    if (refV === undefined) continue;
    const adcV = p[adcCol] as number;
    if (!Number.isFinite(adcV) || !Number.isFinite(refV)) continue;
    const y = adcV / dacForceDivisor - refV;
    out.push({ ...p, col6: y });
  }
  return out;
}
