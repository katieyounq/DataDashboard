import { useCallback } from "react";
import type { DataFilter } from "../utils/dataFilters";
import { formatElapsed } from "../utils/dataTimeBounds";

interface FilterPanelProps {
  filters: DataFilter[];
  onFiltersChange: (filters: DataFilter[]) => void;
}

export default function FilterPanel({ filters, onFiltersChange }: FilterPanelProps) {
  const toggleFilter = useCallback(
    (id: string) => {
      onFiltersChange(
        filters.map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f))
      );
    },
    [filters, onFiltersChange]
  );

  const renameFilter = useCallback(
    (id: string, name: string) => {
      onFiltersChange(
        filters.map((f) => (f.id === id ? { ...f, name } : f))
      );
    },
    [filters, onFiltersChange]
  );

  const removeFilter = useCallback(
    (id: string) => {
      onFiltersChange(filters.filter((f) => f.id !== id));
    },
    [filters, onFiltersChange]
  );

  if (filters.length === 0) return null;

  return (
    <div className="filter-panel">
      <h4 className="filter-panel-title">Data Filters</h4>
      <p className="filter-panel-hint">
        Drag across any chart to add a filter. Enabled filters remove data points from all pages, calibration, and loss calculations.
      </p>
      <div className="filter-list">
        {filters.map((f) => (
          <div key={f.id} className={`filter-item${f.enabled ? " filter-active" : ""}`}>
            <label className="filter-check-label">
              <input
                type="checkbox"
                checked={f.enabled}
                onChange={() => toggleFilter(f.id)}
              />
            </label>
            <input
              type="text"
              className="filter-name-input"
              value={f.name}
              onChange={(e) => renameFilter(f.id, e.target.value)}
              title="Filter name"
            />
            <span className="filter-range">
              {formatElapsed(f.startElapsedMs)} – {formatElapsed(f.endElapsedMs)}
            </span>
            <button
              type="button"
              className="filter-remove-btn"
              onClick={() => removeFilter(f.id)}
              title="Remove filter"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
