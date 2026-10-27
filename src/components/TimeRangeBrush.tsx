import { useCallback, type ChangeEvent } from "react";
import { formatElapsed } from "../utils/dataTimeBounds";

const SLIDER_STEPS = 1000;

interface TimeRangeBrushProps {
  dataMinMs: number | undefined;
  dataMaxMs: number | undefined;
  lowRatio: number;
  highRatio: number;
  onLowRatioChange: (r: number) => void;
  onHighRatioChange: (r: number) => void;
  onReset: () => void;
}

export default function TimeRangeBrush({
  dataMinMs,
  dataMaxMs,
  lowRatio,
  highRatio,
  onLowRatioChange,
  onHighRatioChange,
  onReset,
}: TimeRangeBrushProps) {
  const valid =
    dataMinMs != null &&
    dataMaxMs != null &&
    Number.isFinite(dataMinMs) &&
    Number.isFinite(dataMaxMs) &&
    dataMaxMs > dataMinMs;

  const lo = valid ? dataMinMs! + (dataMaxMs! - dataMinMs!) * lowRatio : 0;
  const hi = valid ? dataMinMs! + (dataMaxMs! - dataMinMs!) * highRatio : 0;

  const onLowSlider = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value) / SLIDER_STEPS;
      const maxLow = Math.max(0, highRatio - 1 / SLIDER_STEPS);
      onLowRatioChange(Math.min(v, maxLow));
    },
    [highRatio, onLowRatioChange]
  );

  const onHighSlider = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value) / SLIDER_STEPS;
      const minHigh = Math.min(1, lowRatio + 1 / SLIDER_STEPS);
      onHighRatioChange(Math.max(v, minHigh));
    },
    [lowRatio, onHighRatioChange]
  );

  if (!valid) {
    return (
      <div className="time-range-brush time-range-brush--empty">
        <h4 className="ref-sliding-window-title">Time zoom</h4>
        <p className="time-range-brush-empty">Load data to enable time range zoom.</p>
      </div>
    );
  }

  const isFull = highRatio - lowRatio >= 1 - 1 / SLIDER_STEPS;

  return (
    <div className="time-range-brush">
      <div className="time-range-brush-head">
        <div>
          <h4 className="ref-sliding-window-title">Time zoom</h4>
          <p className="ref-sliding-window-hint">
            Drag <strong>Start</strong> and <strong>End</strong> to zoom all charts to a time window (loaded buffer
            unchanged).
          </p>
        </div>
        <button type="button" className="time-range-brush-reset" onClick={onReset}>
          Full range
        </button>
      </div>

      <div className="time-brush-track-wrap" aria-hidden>
        <div className="time-brush-track">
          <div
            className="time-brush-track-fill"
            style={{
              left: `${lowRatio * 100}%`,
              width: `${Math.max(highRatio - lowRatio, 0.004) * 100}%`,
            }}
          />
        </div>
      </div>

      <div className="time-brush-sliders">
        <div className="time-brush-slider-row">
          <label className="time-brush-slider-label" htmlFor="time-brush-start">
            Start
          </label>
          <input
            id="time-brush-start"
            type="range"
            min={0}
            max={SLIDER_STEPS}
            step={1}
            value={Math.round(lowRatio * SLIDER_STEPS)}
            onChange={onLowSlider}
            className="time-brush-range time-brush-range--start"
          />
        </div>
        <div className="time-brush-slider-row">
          <label className="time-brush-slider-label" htmlFor="time-brush-end">
            End
          </label>
          <input
            id="time-brush-end"
            type="range"
            min={0}
            max={SLIDER_STEPS}
            step={1}
            value={Math.round(highRatio * SLIDER_STEPS)}
            onChange={onHighSlider}
            className="time-brush-range time-brush-range--end"
          />
        </div>
      </div>

      <div className="time-brush-times">
        <span className="time-brush-time-pill" title="Visible window start">
          {formatElapsed(lo)}
        </span>
        <span className="time-brush-time-sep">→</span>
        <span className="time-brush-time-pill" title="Visible window end">
          {formatElapsed(hi)}
        </span>
        {isFull && <span className="time-brush-full-badge">full span</span>}
      </div>
    </div>
  );
}
