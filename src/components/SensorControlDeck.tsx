import React from "react";
import EventLegend from "./EventLegend";
import { SlidingWindowAndTimePanel } from "./SlidingWindowPanel";
import { allSensorSlotIds, ROW_LETTERS, REF_CHECKBOXES, type RefCheckId } from "../utils/sensorLayout";
import type { DataConfigRowParsed } from "../utils/dataConfigCsv";

const COLS = [1, 2, 3, 4, 5, 6] as const;

interface SensorControlDeckProps {
  windowSize: number;
  onWindowSizeChange: (n: number) => void;
  dataTimeBounds: { min: number; max: number } | null;
  timeLowRatio: number;
  timeHighRatio: number;
  onTimeLowRatioChange: (r: number) => void;
  onTimeHighRatioChange: (r: number) => void;
  onResetTimeRange: () => void;
  selectedSlots: Set<string>;
  onToggleSlot: (slot: string) => void;
  showSingleEnded: boolean;
  onToggleSingleEnded: () => void;
  showDiff: boolean;
  onToggleDiff: () => void;
  showSingleEndedRE: boolean;
  onToggleSingleEndedRE: () => void;
  showPH: boolean;
  onTogglePH: () => void;
  selectedRefIds: Set<RefCheckId>;
  onToggleRef: (id: RefCheckId) => void;
  tempCols: Set<number>;
  onToggleTempCol: (col: number) => void;
  currCols: Set<number>;
  onToggleCurrCol: (col: number) => void;
  events: number[];
  eventLabels: Map<number, string>;
  hiddenEvents: Set<number>;
  onToggleEvent: (evt: number) => void;
  onSetHiddenEvents?: (hidden: Set<number>) => void;
  eventLatestTimestamp?: Map<number, number>;
  dataConfigEntries?: readonly DataConfigRowParsed[];
  isPolling: boolean;
  onTogglePolling: () => void;
  totalRows: number;
  mode: string;
}

export default function SensorControlDeck({
  windowSize,
  onWindowSizeChange,
  dataTimeBounds,
  timeLowRatio,
  timeHighRatio,
  onTimeLowRatioChange,
  onTimeHighRatioChange,
  onResetTimeRange,
  selectedSlots,
  onToggleSlot,
  showSingleEnded,
  onToggleSingleEnded,
  showDiff,
  onToggleDiff,
  showSingleEndedRE,
  onToggleSingleEndedRE,
  showPH,
  onTogglePH,
  selectedRefIds,
  onToggleRef,
  tempCols,
  onToggleTempCol,
  currCols,
  onToggleCurrCol,
  events,
  eventLabels,
  hiddenEvents,
  onToggleEvent,
  onSetHiddenEvents,
  eventLatestTimestamp,
  dataConfigEntries,
  isPolling,
  onTogglePolling,
  totalRows,
  mode,
}: SensorControlDeckProps) {
  const slots = allSensorSlotIds();

  return (
    <div className="se-re-bottom-deck sensor-deck-page1">
      <div className="se-re-deck-col se-re-deck-config sensor-deck-page1-controls">
        <h4 className="se-re-deck-heading">Sensors · signal · REF · TEMP · CURR</h4>
        <div className="sensor-deck-page1-inner">
          <div className="deck-col deck-col-sensors">
            <h4>Sensors</h4>
            <div className="plate-grid plate-grid--compact plate-grid--check">
              <div className="plate-grid-corner" />
              {COLS.map((c) => (
                <div key={c} className="plate-grid-col-hdr">{c}</div>
              ))}
              {ROW_LETTERS.map((row) => (
                <React.Fragment key={row}>
                  <div className="plate-grid-row-hdr">{row}</div>
                  {COLS.map((c) => {
                    const id = `${c}${row}`;
                    const checked = selectedSlots.has(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`plate-grid-cell${checked ? " plate-grid-cell--active" : ""}`}
                        onClick={() => onToggleSlot(id)}
                      >
                        {id}
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>

          <div className="deck-col deck-col-signal">
            <h4>Signal</h4>
            <div className="deck-pills">
              <button
                type="button"
                className={`deck-pill${showSingleEnded ? " deck-pill--active" : ""}`}
                onClick={onToggleSingleEnded}
              >
                Single Ended
              </button>
              <button
                type="button"
                className={`deck-pill${showDiff ? " deck-pill--active" : ""}`}
                onClick={onToggleDiff}
              >
                Diff
              </button>
              <button
                type="button"
                className={`deck-pill${showSingleEndedRE ? " deck-pill--active" : ""}`}
                onClick={onToggleSingleEndedRE}
              >
                DAC force
              </button>
              <button
                type="button"
                className={`deck-pill${showPH ? " deck-pill--active" : ""}`}
                onClick={onTogglePH}
              >
                pH
              </button>
            </div>
          </div>

          <div className="deck-col deck-col-ref">
            <h4>REF</h4>
            <div className="deck-pills deck-pills--wrap">
              {REF_CHECKBOXES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`deck-pill deck-pill--sm${selectedRefIds.has(r.id) ? " deck-pill--active" : ""}`}
                  onClick={() => onToggleRef(r.id)}
                  title={r.label}
                >
                  {r.label.replace(/^REF\s+/i, "")}
                </button>
              ))}
            </div>
          </div>

          <div className="deck-col deck-col-temp-curr">
            <div className="deck-temp-curr-row">
              <h4>TEMP</h4>
              <div className="deck-pills">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`deck-pill deck-pill--sm${tempCols.has(n) ? " deck-pill--active" : ""}`}
                    onClick={() => onToggleTempCol(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="deck-temp-curr-row">
              <h4>CURR</h4>
              <div className="deck-pills">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`deck-pill deck-pill--sm${currCols.has(n) ? " deck-pill--active" : ""}`}
                    onClick={() => onToggleCurrCol(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <p className="se-re-formula-hint">
          Toggle slots and ADC columns for the charts above. Time range is shared when you switch
          to page 2.
        </p>
      </div>

      <div className="se-re-deck-col se-re-deck-events">
        <EventLegend
          events={events}
          eventLabels={eventLabels}
          hiddenEvents={hiddenEvents}
          onToggleEvent={onToggleEvent}
          onSetHiddenEvents={onSetHiddenEvents}
          eventLatestTimestamp={eventLatestTimestamp}
          dataConfigEntries={dataConfigEntries}
        />
      </div>

      <div className="se-re-deck-col se-re-deck-window">
        <h4 className="se-re-deck-heading">Time sliding window</h4>
        <SlidingWindowAndTimePanel
          windowSize={windowSize}
          onWindowSizeChange={onWindowSizeChange}
          dataTimeBounds={dataTimeBounds}
          timeLowRatio={timeLowRatio}
          timeHighRatio={timeHighRatio}
          onLowRatioChange={onTimeLowRatioChange}
          onHighRatioChange={onTimeHighRatioChange}
          onResetTimeRange={onResetTimeRange}
          rangeInputId="page1-window-range"
        />
        {mode === "live" && (
          <div className="se-re-live-mini">
            <button
              type="button"
              className={`stream-btn ${isPolling ? "active" : ""}`}
              onClick={onTogglePolling}
            >
              {isPolling ? "Stop" : "Resume"}
            </button>
            <span className="progress-text">{totalRows.toLocaleString()} rows</span>
          </div>
        )}
      </div>
    </div>
  );
}
