import type { DataRow } from "./csvParser";

export interface DataFilter {
  id: string;
  name: string;
  /** Inclusive lower bound in elapsed milliseconds. */
  startElapsedMs: number;
  /** Inclusive upper bound in elapsed milliseconds. */
  endElapsedMs: number;
  enabled: boolean;
}

let _nextId = 1;
export function newFilterId(): string {
  return `flt-${Date.now()}-${_nextId++}`;
}

/**
 * Remove data points that fall inside any enabled filter's time range.
 * Returns a new Map (does not mutate the original).
 */
export function applyFilters(
  tokenMap: Map<string, DataRow[]>,
  filters: DataFilter[]
): Map<string, DataRow[]> {
  const active = filters.filter((f) => f.enabled);
  if (active.length === 0) return tokenMap;

  const out = new Map<string, DataRow[]>();
  for (const [token, pts] of tokenMap) {
    out.set(
      token,
      pts.filter((p) => {
        const t = p.elapsedSeconds * 1000;
        for (const f of active) {
          if (t >= f.startElapsedMs && t <= f.endElapsedMs) return false;
        }
        return true;
      })
    );
  }
  return out;
}
