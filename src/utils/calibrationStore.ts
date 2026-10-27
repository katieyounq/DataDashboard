/**
 * Shared calibration data: stores sensitivity + offset per ISFET (UL/UR/LL)
 * for each sensor calibration (e.g. 6A-1, 6A-2, 5B-1).
 */

export type ISFETRole = "UL" | "UR" | "LL";

export interface CalibrationEntry {
  id: string;
  sensor: string;
  calibrationNumber: number;
  /** Display label: e.g. "6A-1" */
  label: string;
  values: Record<ISFETRole, { sensitivity: string; offset: string; r2: string }>;
}

export interface CalibrationPoint {
  id: string;
  eventCounters: number[];
  ph: string;
}

/** Target analyte concentration calibration: 4PL per ISFET role. */
export interface TargetCalibrationEntry {
  id: string;
  calibrationNumber: number;
  label: string;
  sensorSlots: string[];
  refId: string;
  loss: number;
  roles: {
    [role: string]: {
      a: string;
      b: string;
      c: string;
      d: string;
      r2: string;
    };
  };
}

/** Combination pH electrode calibration: single regression from REF_A − REF_B. */
export interface CombPHCalibrationEntry {
  id: string;
  refAId: string;
  refBId: string;
  calibrationNumber: number;
  label: string;
  sensitivity: string;
  offset: string;
  r2: string;
}

export function makeCalibrationLabel(sensor: string, n: number): string {
  return `${sensor}-${n}`;
}

export function makeCombPHLabel(refA: string, refB: string, n: number): string {
  return `CombpH(${refA}−${refB})-${n}`;
}

export function nextCalibrationNumber(
  entries: CalibrationEntry[],
  sensor: string
): number {
  let max = 0;
  for (const e of entries) {
    if (e.sensor === sensor && e.calibrationNumber > max) {
      max = e.calibrationNumber;
    }
  }
  return max + 1;
}

export function nextCombPHCalibrationNumber(
  entries: CombPHCalibrationEntry[],
  refAId: string,
  refBId: string
): number {
  let max = 0;
  for (const e of entries) {
    if (e.refAId === refAId && e.refBId === refBId && e.calibrationNumber > max) {
      max = e.calibrationNumber;
    }
  }
  return max + 1;
}

export function nextTargetCalibrationNumber(
  entries: TargetCalibrationEntry[],
  slots: string[]
): number {
  const key = slots.slice().sort().join(",");
  let max = 0;
  for (const e of entries) {
    if (e.sensorSlots.slice().sort().join(",") === key && e.calibrationNumber > max) {
      max = e.calibrationNumber;
    }
  }
  return max + 1;
}

export function makeTargetCalibrationLabel(slots: string[], n: number): string {
  return `TargetCal(${slots.join("+")})-${n}`;
}

export function newEntryId(): string {
  return `cal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 4-Parameter Logistic (4PL) curve fit.
 * Model: y = D + (A - D) / (1 + (x / C)^B)
 * Uses Levenberg-Marquardt style iterative fitting.
 */
export interface FourPLParams {
  a: number;  // minimum asymptote
  b: number;  // Hill slope
  c: number;  // inflection point (EC50)
  d: number;  // maximum asymptote
  r2: number;
}

export function fit4PL(
  points: { x: number; y: number }[]
): FourPLParams | null {
  const n = points.length;
  if (n < 4) return null;

  const sortedByX = [...points].sort((a, b) => a.x - b.x);
  let a = sortedByX[0].y;
  let d = sortedByX[n - 1].y;
  if (Math.abs(a - d) < 1e-15) {
    a = Math.min(...points.map((p) => p.y));
    d = Math.max(...points.map((p) => p.y));
  }
  let b = 1.0;
  const midY = (a + d) / 2;
  let bestDist = Infinity;
  let cInit = 1;
  for (const p of sortedByX) {
    const dist = Math.abs(p.y - midY);
    if (dist < bestDist) {
      bestDist = dist;
      cInit = p.x;
    }
  }
  let c = cInit > 0 ? cInit : 1;

  const predict = (x: number, pa: number, pb: number, pc: number, pd: number) => {
    if (pc === 0) return pd;
    const ratio = x / pc;
    if (ratio <= 0) return pd + (pa - pd);
    return pd + (pa - pd) / (1 + Math.pow(ratio, pb));
  };

  const residuals = (pa: number, pb: number, pc: number, pd: number) => {
    let ss = 0;
    for (const p of points) {
      const pred = predict(p.x, pa, pb, pc, pd);
      ss += (p.y - pred) ** 2;
    }
    return ss;
  };

  let lambda = 0.001;
  const maxIter = 2000;
  const params = [a, b, c, d];

  for (let iter = 0; iter < maxIter; iter++) {
    const [pa, pb, pc, pd] = params;
    const ssOld = residuals(pa, pb, pc, pd);
    const eps = 1e-8;
    const grad = [0, 0, 0, 0];
    const hess = Array.from({ length: 4 }, () => new Float64Array(4));

    const jacobianRow = (x: number, y: number) => {
      const pred = predict(x, pa, pb, pc, pd);
      const r = y - pred;
      const ratio = pc !== 0 && x / pc > 0 ? x / pc : 1e-30;
      const rB = Math.pow(ratio, pb);
      const denom = 1 + rB;
      const denom2 = denom * denom;
      const adDiff = pa - pd;

      const dA = 1 / denom;
      const dD = 1 - 1 / denom;
      const dB = rB > 0 && ratio > 0 ? -adDiff * rB * Math.log(ratio) / denom2 : 0;
      const dC = pc !== 0 ? adDiff * pb * rB / (pc * denom2) : 0;

      const J = [dA, dB, dC, dD];
      for (let i = 0; i < 4; i++) {
        grad[i] += r * J[i];
        for (let j = 0; j < 4; j++) {
          hess[i][j] += J[i] * J[j];
        }
      }
    };

    for (const p of points) jacobianRow(p.x, p.y);

    for (let i = 0; i < 4; i++) {
      hess[i][i] *= (1 + lambda);
    }

    // Solve 4x4 system via Gauss elimination
    const aug = hess.map((row, i) => [...row, grad[i]]);
    let singular = false;
    for (let col = 0; col < 4; col++) {
      let maxRow = col;
      for (let row = col + 1; row < 4; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
      }
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      if (Math.abs(aug[col][col]) < 1e-30) { singular = true; break; }
      for (let row = col + 1; row < 4; row++) {
        const f = aug[row][col] / aug[col][col];
        for (let j = col; j < 5; j++) aug[row][j] -= f * aug[col][j];
      }
    }

    if (singular) {
      lambda *= 10;
      continue;
    }

    const delta = new Float64Array(4);
    for (let i = 3; i >= 0; i--) {
      delta[i] = aug[i][4];
      for (let j = i + 1; j < 4; j++) delta[i] -= aug[i][j] * delta[j];
      delta[i] /= aug[i][i];
    }

    const newParams = params.map((v, i) => v + delta[i]);
    if (newParams[2] <= 0) newParams[2] = Math.abs(newParams[2]) || eps;

    const ssNew = residuals(newParams[0], newParams[1], newParams[2], newParams[3]);
    if (ssNew < ssOld) {
      params[0] = newParams[0];
      params[1] = newParams[1];
      params[2] = newParams[2];
      params[3] = newParams[3];
      lambda = Math.max(lambda / 10, 1e-10);
      if (Math.abs(ssOld - ssNew) / (ssOld + 1e-30) < 1e-12) break;
    } else {
      lambda *= 10;
      if (lambda > 1e10) break;
    }
  }

  const [fa, fb, fc, fd] = params;
  const yMean = points.reduce((s, p) => s + p.y, 0) / n;
  const ssTot = points.reduce((s, p) => s + (p.y - yMean) ** 2, 0);
  const ssRes = residuals(fa, fb, fc, fd);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  return { a: fa, b: fb, c: fc, d: fd, r2 };
}

/**
 * Simple linear regression: y = slope * x + intercept.
 * Returns { slope, intercept, r2 } or null if not enough points.
 */
export function linearRegression(
  points: { x: number; y: number }[]
): { slope: number; intercept: number; r2: number } | null {
  const n = points.length;
  if (n < 2) return null;

  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    syy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
    syy += p.y * p.y;
  }

  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-15) return null;

  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  const ssTot = syy - (sy * sy) / n;
  const ssRes = points.reduce((acc, p) => {
    const pred = slope * p.x + intercept;
    return acc + (p.y - pred) ** 2;
  }, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  return { slope, intercept, r2 };
}
