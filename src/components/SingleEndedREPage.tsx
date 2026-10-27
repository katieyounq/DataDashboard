import { useCallback, useMemo, useState } from "react";
import {
  buildEventLatestTimestamps,
  resolveEventVisual,
  resolveEventVisualByCounter,
  type DataConfigRowParsed,
} from "../utils/dataConfigCsv";
import OverlayChart, { type OverlaySeries } from "./OverlayChart";
import EventLegend from "./EventLegend";
import { SlidingWindowAndTimePanel } from "./SlidingWindowPanel";
import { getDataTimeBounds, elapsedMs } from "../utils/dataTimeBounds";
import { deriveSingleEndedMinusRef } from "../utils/singleEndedREMath";
import {
  ADC_ROLE_BORDER_DASH,
  adcTripletForSlot,
  REF_CHECKBOXES,
  SERIES_PALETTE,
  slotDataColumn,
  type RefCheckId,
} from "../utils/sensorLayout";
import { type DataRow, getEventColor } from "../utils/csvParser";
import SlotPicker from "./SlotPicker";

const VALUE_COL: keyof DataRow = "col6";
const NEUTRAL_LINE = "#94a3b8";
const ROLE_COLORS = { ur: "#ef4444", ul: "#3b82f6", ll: "#22c55e" };

/** Pointwise subtract two derived DataRow[] arrays (matched by loopCounter, reading col6). */
function pointwiseDiff(ptsA: DataRow[], ptsB: DataRow[]): DataRow[] {
  const bByLoop = new Map<number, number>();
  for (const p of ptsB) {
    if (Number.isFinite(p.col6)) bByLoop.set(p.loopCounter, p.col6);
  }
  const out: DataRow[] = [];
  for (const p of ptsA) {
    const bVal = bByLoop.get(p.loopCounter);
    if (bVal === undefined || !Number.isFinite(p.col6)) continue;
    out.push({ ...p, col6: p.col6 - bVal });
  }
  return out;
}

export interface RERowConfig {
  id: string;
  slot: string;
  /** Loss (DAC force) divisor — same role as `dacForce` in the data stream. */
  dacForce: string;
  refId: RefCheckId;
}


function newRowId(): string {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface SingleEndedREPageProps {
  windowedTokenMap: Map<string, DataRow[]>;
  windowSize: number;
  onWindowSizeChange: (n: number) => void;
  rows: RERowConfig[];
  onRowsChange: (rows: RERowConfig[]) => void;
  events: number[];
  eventLabels: Map<number, string>;
  hiddenEvents: Set<number>;
  onToggleEvent: (evt: number) => void;
  onSetHiddenEvents?: (hidden: Set<number>) => void;
  isPolling: boolean;
  onTogglePolling: () => void;
  totalRows: number;
  mode: string;
  dataConfigEntries?: readonly DataConfigRowParsed[];
  allEventsLatestTimestamp?: Map<number, number>;
  onRangeSelect?: (startMs: number, endMs: number) => void;
  globalDenoise?: boolean;
  denoiseParams?: import("../utils/denoise").DenoiseParams;
}

function parseDacForceDivisor(s: string): number {
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0.9;
}

function refMeta(id: RefCheckId) {
  return REF_CHECKBOXES.find((r) => r.id === id) ?? REF_CHECKBOXES[0];
}

export default function SingleEndedREPage({
  windowedTokenMap,
  windowSize,
  onWindowSizeChange,
  rows,
  onRowsChange: setRows,
  events,
  eventLabels,
  hiddenEvents,
  onToggleEvent,
  onSetHiddenEvents,
  isPolling,
  onTogglePolling,
  totalRows,
  mode,
  dataConfigEntries = [],
  allEventsLatestTimestamp,
  onRangeSelect,
  globalDenoise,
  denoiseParams,
}: SingleEndedREPageProps) {
  const [timeLowRatio, setTimeLowRatio] = useState(0);
  const [timeHighRatio, setTimeHighRatio] = useState(1);
  const [diffEntryA, setDiffEntryA] = useState(0);
  const [diffEntryB, setDiffEntryB] = useState(1);

  const dataTimeBounds = useMemo(() => getDataTimeBounds(windowedTokenMap), [windowedTokenMap]);

  /** Include whole mux loops: any loop touched by the time brush keeps all token rows for that loop (avoids REF/ADC split by timestamp). */
  const chartDataMap = useMemo(() => {
    if (!dataTimeBounds) return windowedTokenMap;
    const span = dataTimeBounds.max - dataTimeBounds.min;
    const lo = dataTimeBounds.min + span * timeLowRatio;
    const hi = dataTimeBounds.min + span * timeHighRatio;
    if (hi <= lo) return windowedTokenMap;

    const loopsInBrush = new Set<number>();
    for (const pts of windowedTokenMap.values()) {
      for (const p of pts) {
        const t = elapsedMs(p);
        if (t >= lo && t <= hi) {
          loopsInBrush.add(p.loopCounter);
        }
      }
    }

    const out = new Map<string, DataRow[]>();
    if (loopsInBrush.size === 0) {
      for (const [k, pts] of windowedTokenMap) {
        out.set(
          k,
          pts.filter((p) => { const t = elapsedMs(p); return t >= lo && t <= hi; })
        );
      }
      return out;
    }

    for (const [k, pts] of windowedTokenMap) {
      out.set(k, pts.filter((p) => loopsInBrush.has(p.loopCounter)));
    }
    return out;
  }, [windowedTokenMap, dataTimeBounds, timeLowRatio, timeHighRatio]);

  const eventLatestTimestamp = useMemo(
    () => buildEventLatestTimestamps(chartDataMap),
    [chartDataMap]
  );

  const resolvePointEventVisual = useCallback(
    (p: DataRow) =>
      resolveEventVisual(p.timestamp, p.eventCounter, eventLabels, dataConfigEntries),
    [eventLabels, dataConfigEntries]
  );

  const eventColorKey = useMemo(() => {
    return events.map((evt) => {
      const ts = eventLatestTimestamp.get(evt);
      if (ts !== undefined) {
        const v = resolveEventVisual(ts, evt, eventLabels, dataConfigEntries);
        return { event: evt, label: v.caption, color: v.color };
      }
      const v = resolveEventVisualByCounter(evt, eventLabels, dataConfigEntries);
      return { event: evt, label: v.caption, color: v.color };
    });
  }, [events, eventLabels, dataConfigEntries, eventLatestTimestamp]);

  const rowDerived = useMemo(() => {
    return rows.map((row, ri) => {
      const rowColor = SERIES_PALETTE[ri % SERIES_PALETTE.length];
      const dacForceDivisor = parseDacForceDivisor(row.dacForce);
      const ref = refMeta(row.refId);
      const triplet = adcTripletForSlot(row.slot);
      const adcCol = slotDataColumn(row.slot);
      const refPts = chartDataMap.get(ref.token) || [];

      const ul = deriveSingleEndedMinusRef(
        chartDataMap.get(triplet.ul) || [],
        dacForceDivisor,
        refPts,
        ref.col,
        adcCol
      );
      const ur = deriveSingleEndedMinusRef(
        chartDataMap.get(triplet.ur) || [],
        dacForceDivisor,
        refPts,
        ref.col,
        adcCol
      );
      const ll = deriveSingleEndedMinusRef(
        chartDataMap.get(triplet.ll) || [],
        dacForceDivisor,
        refPts,
        ref.col,
        adcCol
      );

      const overlaySeries: OverlaySeries[] = [
        {
          key: `${row.id}-ul`,
          label: `UL`,
          points: ul,
          color: ROLE_COLORS.ul,
          borderDash: [...ADC_ROLE_BORDER_DASH.ul],
        },
        {
          key: `${row.id}-ur`,
          label: `UR`,
          points: ur,
          color: ROLE_COLORS.ur,
          borderDash: [...ADC_ROLE_BORDER_DASH.ur],
        },
        {
          key: `${row.id}-ll`,
          label: `LL`,
          points: ll,
          color: ROLE_COLORS.ll,
          borderDash: [...ADC_ROLE_BORDER_DASH.ll],
        },
      ];

      const shortRef = ref.label.replace(/^REF\s+/i, "");
      return {
        row,
        rowColor,
        dacForceDivisor,
        refLabel: ref.label,
        titles: {
          ul: `${row.slot} UL / loss − ${ref.label}`,
          ur: `${row.slot} UR / loss − ${ref.label}`,
          ll: `${row.slot} LL / loss − ${ref.label}`,
          /* Note: chart rendering order is UL, UR, LL */
          ov: `${row.slot} / loss − ${shortRef} overlaid`,
        },
        ul,
        ur,
        ll,
        overlaySeries,
      };
    });
  }, [rows, chartDataMap]);

  const bigOverlaySeries: OverlaySeries[] = useMemo(() => {
    const list: OverlaySeries[] = [];
    for (const d of rowDerived) {
      for (const [role, pts, dash, roleColor] of [
        ["UL", d.ul, ADC_ROLE_BORDER_DASH.ul, ROLE_COLORS.ul],
        ["UR", d.ur, ADC_ROLE_BORDER_DASH.ur, ROLE_COLORS.ur],
        ["LL", d.ll, ADC_ROLE_BORDER_DASH.ll, ROLE_COLORS.ll],
      ] as const) {
        list.push({
          key: `${d.row.id}-${role}`,
          label: `${d.row.slot} ${role} (${d.refLabel})`,
          points: pts,
          color: roleColor,
          borderDash: [...dash],
        });
      }
    }
    return list;
  }, [rowDerived]);

  const entryDiffData = useMemo(() => {
    const a = rowDerived[diffEntryA];
    const b = rowDerived[diffEntryB];
    if (!a || !b || diffEntryA === diffEntryB) return null;
    const ur = pointwiseDiff(a.ur, b.ur);
    const ul = pointwiseDiff(a.ul, b.ul);
    const ll = pointwiseDiff(a.ll, b.ll);
    const labelA = `${a.row.slot} L${a.row.dacForce} ${a.refLabel}`;
    const labelB = `${b.row.slot} L${b.row.dacForce} ${b.refLabel}`;
    const overlay: OverlaySeries[] = [
      { key: "ed-ul", label: "UL", points: ul, color: ROLE_COLORS.ul, borderDash: [...ADC_ROLE_BORDER_DASH.ul] },
      { key: "ed-ur", label: "UR", points: ur, color: ROLE_COLORS.ur, borderDash: [...ADC_ROLE_BORDER_DASH.ur] },
      { key: "ed-ll", label: "LL", points: ll, color: ROLE_COLORS.ll, borderDash: [...ADC_ROLE_BORDER_DASH.ll] },
    ];
    return { ur, ul, ll, overlay, labelA, labelB };
  }, [rowDerived, diffEntryA, diffEntryB]);

  const updateRow = (id: string, patch: Partial<RERowConfig>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addSensorLine = useCallback(() => {
    setRows((prev) => {
      const last = prev[prev.length - 1];
      return [
        ...prev,
        {
          id: newRowId(),
          slot: last?.slot ?? "1A",
          dacForce: last?.dacForce ?? "0.9",
          refId: last?.refId ?? "ref-1a",
        },
      ];
    });
  }, []);

  const removeSensorLine = useCallback((id: string) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
  }, []);

  return (
    <div className="se-re-page">
      <div className="se-re-chart-area">
        <div className="chart-color-key">
          <span className="color-key-group">
            <span className="color-key-title">Lines:</span>
            <span className="color-key-item">
              <span className="color-key-line color-key-line--dashed" style={{ borderColor: ROLE_COLORS.ul }} />UL (dash)
            </span>
            <span className="color-key-item">
              <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ur }} />UR (solid)
            </span>
            <span className="color-key-item">
              <span className="color-key-line color-key-line--dotdash" style={{ borderColor: ROLE_COLORS.ll }} />LL (dot-dash)
            </span>
          </span>
          {eventColorKey.length > 0 && (
            <span className="color-key-group">
              <span className="color-key-title">Events:</span>
              {eventColorKey.map((e) => (
                <span key={e.event} className="color-key-item">
                  <span className="color-key-dot" style={{ backgroundColor: e.color }} />
                  {e.label}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="se-re-small-grid">
          {rowDerived.map((d) => (
            <div key={d.row.id} className="se-re-row-charts">
              <OverlayChart pageTitle="SE-REF"
                title={d.titles.ul}
                series={[
                  {
                    key: "ul",
                    label: d.titles.ul,
                    points: d.ul,
                    color: ROLE_COLORS.ul,
                    borderDash: [...ADC_ROLE_BORDER_DASH.ul],
                  },
                ]}
                column={VALUE_COL}
                height={200}
                showLegend={false}
                yUnit="V"
                colorByEvent
                eventLabels={eventLabels}
                resolveEventVisual={resolvePointEventVisual}
                onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
              />
              <OverlayChart pageTitle="SE-REF"
                title={d.titles.ur}
                series={[
                  {
                    key: "ur",
                    label: d.titles.ur,
                    points: d.ur,
                    color: ROLE_COLORS.ur,
                    borderDash: [...ADC_ROLE_BORDER_DASH.ur],
                  },
                ]}
                column={VALUE_COL}
                height={200}
                showLegend={false}
                yUnit="V"
                colorByEvent
                eventLabels={eventLabels}
                resolveEventVisual={resolvePointEventVisual}
                onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
              />
              <OverlayChart pageTitle="SE-REF"
                title={d.titles.ll}
                series={[
                  {
                    key: "ll",
                    label: d.titles.ll,
                    points: d.ll,
                    color: ROLE_COLORS.ll,
                    borderDash: [...ADC_ROLE_BORDER_DASH.ll],
                  },
                ]}
                column={VALUE_COL}
                height={200}
                showLegend={false}
                yUnit="V"
                colorByEvent
                eventLabels={eventLabels}
                resolveEventVisual={resolvePointEventVisual}
                onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
              />
              <OverlayChart pageTitle="SE-REF"
                title={d.titles.ov}
                series={d.overlaySeries}
                column={VALUE_COL}
                height={200}
                yUnit="V"
                onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
              />
            </div>
          ))}
        </div>

        <section className="se-re-large-panel">
          <h3 className="se-re-large-title">Single-ended − REF — combined (ADC ÷ loss) − REF</h3>
          <OverlayChart pageTitle="SE-REF"
            title="All (ADC ÷ loss) − REF traces"
            series={bigOverlaySeries}
            column={VALUE_COL}
            height={320}
            legendMaxHeight={100}
            yUnit="V"
            onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
          />
        </section>

        {rows.length >= 2 && (
          <section className="entry-diff-section">
            <h3 className="entry-diff-title">Entry Difference — (ADC ÷ loss) − REF</h3>
            <p className="entry-diff-hint">
              Select two entries above to display the pointwise difference of their derived values.
            </p>
            <div className="entry-diff-selectors">
              <div className="entry-diff-sel-group">
                <span className="entry-diff-sel-label">Entry A</span>
                <select
                  className="entry-diff-select"
                  value={diffEntryA}
                  onChange={(e) => setDiffEntryA(Number(e.target.value))}
                >
                  {rows.map((row, i) => {
                    const ref = REF_CHECKBOXES.find((r) => r.id === row.refId);
                    return (
                      <option key={row.id} value={i}>
                        {row.slot} · loss {row.dacForce} · {ref?.label ?? row.refId}
                      </option>
                    );
                  })}
                </select>
              </div>
              <span className="entry-diff-minus">−</span>
              <div className="entry-diff-sel-group">
                <span className="entry-diff-sel-label">Entry B</span>
                <select
                  className="entry-diff-select"
                  value={diffEntryB}
                  onChange={(e) => setDiffEntryB(Number(e.target.value))}
                >
                  {rows.map((row, i) => {
                    const ref = REF_CHECKBOXES.find((r) => r.id === row.refId);
                    return (
                      <option key={row.id} value={i}>
                        {row.slot} · loss {row.dacForce} · {ref?.label ?? row.refId}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
            {!entryDiffData ? (
              <div className="entry-diff-empty">Select two different entries to see their difference.</div>
            ) : (
              <div className="entry-diff-charts">
                <OverlayChart pageTitle="SE-REF"
                  title={`UL: ${entryDiffData.labelA} − ${entryDiffData.labelB}`}
                  series={[{ key: "ed-ul", label: "UL diff", points: entryDiffData.ul, color: ROLE_COLORS.ul, borderDash: [...ADC_ROLE_BORDER_DASH.ul] }]}
                  column={VALUE_COL}
                  height={200}
                  showLegend={false}
                  yUnit="V"
                  colorByEvent
                  eventLabels={eventLabels}
                  resolveEventVisual={resolvePointEventVisual}
                  onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                />
                <OverlayChart pageTitle="SE-REF"
                  title={`UR: ${entryDiffData.labelA} − ${entryDiffData.labelB}`}
                  series={[{ key: "ed-ur", label: "UR diff", points: entryDiffData.ur, color: ROLE_COLORS.ur, borderDash: [...ADC_ROLE_BORDER_DASH.ur] }]}
                  column={VALUE_COL}
                  height={200}
                  showLegend={false}
                  yUnit="V"
                  colorByEvent
                  eventLabels={eventLabels}
                  resolveEventVisual={resolvePointEventVisual}
                  onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                />
                <OverlayChart pageTitle="SE-REF"
                  title={`LL: ${entryDiffData.labelA} − ${entryDiffData.labelB}`}
                  series={[{ key: "ed-ll", label: "LL diff", points: entryDiffData.ll, color: ROLE_COLORS.ll, borderDash: [...ADC_ROLE_BORDER_DASH.ll] }]}
                  column={VALUE_COL}
                  height={200}
                  showLegend={false}
                  yUnit="V"
                  colorByEvent
                  eventLabels={eventLabels}
                  resolveEventVisual={resolvePointEventVisual}
                  onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                />
                <OverlayChart pageTitle="SE-REF"
                  title={`Difference overlaid`}
                  series={entryDiffData.overlay}
                  column={VALUE_COL}
                  height={200}
                  yUnit="V"
                  onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                />
              </div>
            )}
          </section>
        )}
      </div>

      <div className="se-re-bottom-deck">
        <div className="se-re-deck-col se-re-deck-config">
          <h4 className="se-re-deck-heading">Sensor / loss (default 0.9) − REF</h4>
          <div className="se-re-config-table">
            {rows.map((row) => (
              <div key={row.id} className="se-re-config-row">
                <SlotPicker
                  value={row.slot}
                  onChange={(slot) => updateRow(row.id, { slot })}
                />
                <div className="se-re-config-fields">
                  <label className="se-re-field-label">
                    Loss
                    <input
                      type="text"
                      className="se-re-dac-force-input"
                      value={row.dacForce}
                      onChange={(e) => updateRow(row.id, { dacForce: e.target.value })}
                      placeholder="0.9"
                    />
                  </label>
                  <div className="se-re-field-label">
                    REF
                    <div className="deck-pills deck-pills--wrap">
                      {REF_CHECKBOXES.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          className={`deck-pill deck-pill--sm${row.refId === r.id ? " deck-pill--active" : ""}`}
                          onClick={() => updateRow(row.id, { refId: r.id })}
                        >
                          {r.label.replace(/^REF\s+/i, "")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="se-re-remove-line"
                    disabled={rows.length <= 1}
                    onClick={() => removeSensorLine(row.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="se-re-config-footer-actions">
            <button type="button" className="se-re-add-line" onClick={addSensorLine}>
              Add sensor line
            </button>
          </div>
          <p className="se-re-formula-hint">
            DAC force uses <code>(ADC<sub>col6</sub> ÷ loss) − REF</code> with the same{" "}
            <strong>loop counter</strong> for ADC and REF. Loss is the DAC force term (log field{" "}
            <code>dacForce</code>). The time brush keeps whole loops so REF and ADC stay aligned.
          </p>
        </div>

        <div className="se-re-deck-col se-re-deck-events">
          <EventLegend
            events={events}
            eventLabels={eventLabels}
            hiddenEvents={hiddenEvents}
            onToggleEvent={onToggleEvent}
            onSetHiddenEvents={onSetHiddenEvents}
            eventLatestTimestamp={allEventsLatestTimestamp ?? eventLatestTimestamp}
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
            onLowRatioChange={setTimeLowRatio}
            onHighRatioChange={setTimeHighRatio}
            onResetTimeRange={() => {
              setTimeLowRatio(0);
              setTimeHighRatio(1);
            }}
            rangeInputId="se-re-window-range"
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
    </div>
  );
}
