import TimeRangeBrush from "./TimeRangeBrush";

export const WINDOW_PRESETS = [100, 250, 500, 1000, 2500, 0] as const;

export function SlidingWindowBar({
  windowSize,
  onWindowSizeChange,
  rangeInputId = "ref-window-range",
}: {
  windowSize: number;
  onWindowSizeChange: (n: number) => void;
  rangeInputId?: string;
}) {
  return (
    <div className="ref-sliding-window-points">
      <div className="ref-sliding-window-text">
        <h4 className="ref-sliding-window-title">Sliding window</h4>
        <p className="ref-sliding-window-hint">Recent points to show per token (all charts)</p>
      </div>
      <div className="ref-sliding-window-controls">
        <div className="rail-window-presets ref-window-presets">
          {WINDOW_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`rail-window-preset ${windowSize === preset ? "active" : ""}`}
              onClick={() => onWindowSizeChange(preset)}
            >
              {preset === 0 ? "All" : preset}
            </button>
          ))}
        </div>
        <div className="rail-window-slider-block ref-window-slider-block">
          <label className="rail-window-slider-label" htmlFor={rangeInputId}>
            Fine tune
          </label>
          <input
            id={rangeInputId}
            type="range"
            min={50}
            max={5000}
            step={50}
            value={windowSize || 5000}
            onChange={(e) => onWindowSizeChange(Number(e.target.value))}
            className="rail-window-range"
          />
          <div className="rail-window-value">
            {windowSize === 0 ? "All points" : `${windowSize.toLocaleString()} pts`}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SlidingWindowAndTimePanel({
  windowSize,
  onWindowSizeChange,
  dataTimeBounds,
  timeLowRatio,
  timeHighRatio,
  onLowRatioChange,
  onHighRatioChange,
  onResetTimeRange,
  rangeInputId,
}: {
  windowSize: number;
  onWindowSizeChange: (n: number) => void;
  dataTimeBounds: { min: number; max: number } | null;
  timeLowRatio: number;
  timeHighRatio: number;
  onLowRatioChange: (r: number) => void;
  onHighRatioChange: (r: number) => void;
  onResetTimeRange: () => void;
  rangeInputId?: string;
}) {
  return (
    <div className="ref-sliding-window-card">
      <SlidingWindowBar
        windowSize={windowSize}
        onWindowSizeChange={onWindowSizeChange}
        rangeInputId={rangeInputId}
      />
      <div className="ref-sliding-window-divider" aria-hidden />
      <TimeRangeBrush
        dataMinMs={dataTimeBounds?.min}
        dataMaxMs={dataTimeBounds?.max}
        lowRatio={timeLowRatio}
        highRatio={timeHighRatio}
        onLowRatioChange={onLowRatioChange}
        onHighRatioChange={onHighRatioChange}
        onReset={onResetTimeRange}
      />
    </div>
  );
}
