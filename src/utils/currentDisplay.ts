import type { DataRow } from "./csvParser";

/** Magnitude is a display transform; recorded samples are never mutated. */
export function absoluteCurrentRows(points: DataRow[], column: keyof DataRow): DataRow[] {
  return points.map((point) => ({ ...point, [column]: Math.abs(point[column] as number) }));
}

export function formatCurrent(value: number): string {
  return Number.isFinite(value) ? value.toExponential(2) : "—";
}
