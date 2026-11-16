import { downloadLossTable } from "../utils/exportLossTable";
import React, { useCallback, useMemo, useState, type ChangeEvent } from "react";
import OverlayChart, { type OverlaySeries } from "./OverlayChart";
import SlotPicker from "./SlotPicker";
import {
  SERIES_PALETTE,
  ADC_ROLE_BORDER_DASH,
  adcTripletForSlot,
  adcNumFromToken,
  diffTripletForSlot,
  compareSlots,
  REF_CHECKBOXES,
  CURR_TOKEN,
  resolveTemperatureSeries,
  slotDataColumn,
  type RefCheckId,
} from "../utils/sensorLayout";
import { type DataRow, getEventColor } from "../utils/csvParser";
import {
  resolveEventVisual,
  resolveEventVisualByCounter,
  buildEventLatestTimestamps,
  resolveHeartbeatMagnitudeByCounter,
  type DataConfigRowParsed,
} from "../utils/dataConfigCsv";
import { elapsedMs } from "../utils/dataTimeBounds";
import { computeLossPerEvent, lossHeatmapColor, lossHeatmapTextColor, type LossResult } from "../utils/lossCalculation";

const DAC_F_TOKEN = "DAC F (V)";
const VALUE_COL: keyof DataRow = "col6";

function colKey(n: number): keyof DataRow {
  return `col${n}` as keyof DataRow;
}

/**
 * Compute the pointwise difference of single-ended data between two sensors
 * for a given role (UR/UL/LL). Points are matched by loopCounter.
 * Result is stored in col6 of the returned DataRow[].
 */
function sensorSingleEndedDiff(
  chartDataMap: Map<string, DataRow[]>,
  slotA: string,
  slotB: string,
  role: "ur" | "ul" | "ll"
): DataRow[] {
  const tripA = adcTripletForSlot(slotA);
  const tripB = adcTripletForSlot(slotB);
  const colA = slotDataColumn(slotA);
  const colB = slotDataColumn(slotB);

  const tokenA = role === "ur" ? tripA.ur : role === "ul" ? tripA.ul : tripA.ll;
  const tokenB = role === "ur" ? tripB.ur : role === "ul" ? tripB.ul : tripB.ll;

  const ptsA = chartDataMap.get(tokenA) || [];
  const ptsB = chartDataMap.get(tokenB) || [];

  const bByLoop = new Map<number, number>();
  for (const p of ptsB) {
    const v = p[colB] as number;
    if (Number.isFinite(v)) bByLoop.set(p.loopCounter, v);
  }

  const out: DataRow[] = [];
  for (const p of ptsA) {
    const bVal = bByLoop.get(p.loopCounter);
    if (bVal === undefined) continue;
    const aVal = p[colA] as number;
    if (!Number.isFinite(aVal)) continue;
    out.push({ ...p, col6: aVal - bVal });
  }
  return out;
}

interface RawDataDisplayProps {
  windowedTokenMap: Map<string, DataRow[]>;
  dataTimeBounds: { min: number; max: number } | null;
  timeLowRatio: number;
  timeHighRatio: number;
  selectedSlots: Set<string>;
  showSingleEnded: boolean;
  showDiff: boolean;
  showSingleEndedRE: boolean;
  showPH: boolean;
  selectedRefIds: Set<RefCheckId>;
  tempCols: Set<number>;
  currCols: Set<number>;
  events: number[];
  eventLabels: Map<number, string>;
  dataConfigEntries?: readonly DataConfigRowParsed[];
  onRangeSelect?: (startMs: number, endMs: number) => void;
  globalDenoise?: boolean;
  denoiseParams?: import("../utils/denoise").DenoiseParams;
}

export default function RawDataDisplay({
  windowedTokenMap,
  dataTimeBounds,
  timeLowRatio,
  timeHighRatio,
  selectedSlots,
  showSingleEnded,
  showDiff,
  showSingleEndedRE,
  showPH,
  selectedRefIds,
  tempCols,
  currCols,
  events,
  eventLabels,
  dataConfigEntries = [],
  onRangeSelect,
  globalDenoise,
  denoiseParams,
}: RawDataDisplayProps) {
  const [diffSlotA, setDiffSlotA] = useState("1A");
  const [diffSlotB, setDiffSlotB] = useState("6A");
  const [combRefA, setCombRefA] = useState<RefCheckId>("ref-1a");
  const [combRefB, setCombRefB] = useState<RefCheckId>("ref-1b");

  const resolvePointEventVisual = useCallback(
    (p: DataRow) =>
      resolveEventVisual(p.timestamp, p.eventCounter, eventLabels, dataConfigEntries),
    [eventLabels, dataConfigEntries]
  );

  const chartDataMap = useMemo(() => {
    if (!dataTimeBounds) return windowedTokenMap;
    const span = dataTimeBounds.max - dataTimeBounds.min;
    const lo = dataTimeBounds.min + span * timeLowRatio;
    const hi = dataTimeBounds.min + span * timeHighRatio;
    if (hi <= lo) return windowedTokenMap;
    const out = new Map<string, DataRow[]>();
    for (const [k, pts] of windowedTokenMap) {
      out.set(
        k,
        pts.filter((p) => { const t = elapsedMs(p); return t >= lo && t <= hi; })
      );
    }
    return out;
  }, [windowedTokenMap, dataTimeBounds, timeLowRatio, timeHighRatio]);

  const slotsSorted = useMemo(
    () => Array.from(selectedSlots).sort(compareSlots),
    [selectedSlots]
  );


  const ROLE_COLORS = { ur: "#ef4444", ul: "#3b82f6", ll: "#22c55e" };

  const eventLatestTs = useMemo(
    () => buildEventLatestTimestamps(chartDataMap),
    [chartDataMap]
  );

  const eventColorKey = useMemo(() => {
    return events.map((evt) => {
      const ts = eventLatestTs.get(evt);
      if (ts !== undefined) {
        const v = resolveEventVisual(ts, evt, eventLabels, dataConfigEntries);
        return { event: evt, label: v.caption, color: v.color };
      }
      const v = resolveEventVisualByCounter(evt, eventLabels, dataConfigEntries);
      return { event: evt, label: v.caption, color: v.color };
    });
  }, [events, eventLabels, dataConfigEntries, eventLatestTs]);

  function seSeriesForSlot(slot: string): {
    ul: OverlaySeries;
    ur: OverlaySeries;
    ll: OverlaySeries;
    overlay: OverlaySeries[];
  } {
    const t = adcTripletForSlot(slot);
    return {
      ur: {
        key: `${slot}-ur`,
        label: `${slot} UR (${adcNumFromToken(t.ur)})`,
        points: chartDataMap.get(t.ur) || [],
        color: ROLE_COLORS.ur,
        borderDash: [...ADC_ROLE_BORDER_DASH.ur],
      },
      ul: {
        key: `${slot}-ul`,
        label: `${slot} UL (${adcNumFromToken(t.ul)})`,
        points: chartDataMap.get(t.ul) || [],
        color: ROLE_COLORS.ul,
        borderDash: [...ADC_ROLE_BORDER_DASH.ul],
      },
      ll: {
        key: `${slot}-ll`,
        label: `${slot} LL (${adcNumFromToken(t.ll)})`,
        points: chartDataMap.get(t.ll) || [],
        color: ROLE_COLORS.ll,
        borderDash: [...ADC_ROLE_BORDER_DASH.ll],
      },
      overlay: (
        [
          ["UL", t.ul, ADC_ROLE_BORDER_DASH.ul, ROLE_COLORS.ul],
          ["UR", t.ur, ADC_ROLE_BORDER_DASH.ur, ROLE_COLORS.ur],
          ["LL", t.ll, ADC_ROLE_BORDER_DASH.ll, ROLE_COLORS.ll],
        ] as const
      ).map(([role, token, dash, color]) => ({
        key: `${slot}-${role}-ov`,
        label: `${slot} ${role} (${adcNumFromToken(token)})`,
        points: chartDataMap.get(token) || [],
        color,
        borderDash: [...dash],
      })),
    };
  }

  function diffSeriesForSlot(slot: string): {
    urUl: OverlaySeries;
    ulLl: OverlaySeries;
    urLl: OverlaySeries;
    overlay: OverlaySeries[];
  } {
    const d = diffTripletForSlot(slot);
    return {
      urUl: {
        key: `${slot}-du`,
        label: `${slot} UR−UL`,
        points: chartDataMap.get(d.urUl) || [],
        color: ROLE_COLORS.ur,
        borderDash: [...ADC_ROLE_BORDER_DASH.ur],
      },
      ulLl: {
        key: `${slot}-dl`,
        label: `${slot} UL−LL`,
        points: chartDataMap.get(d.ulLl) || [],
        color: ROLE_COLORS.ul,
        borderDash: [...ADC_ROLE_BORDER_DASH.ul],
      },
      urLl: {
        key: `${slot}-dr`,
        label: `${slot} UR−LL`,
        points: chartDataMap.get(d.urLl) || [],
        color: ROLE_COLORS.ll,
        borderDash: [...ADC_ROLE_BORDER_DASH.ll],
      },
      overlay: (
        [
          ["UR−UL", d.urUl, ADC_ROLE_BORDER_DASH.ur, ROLE_COLORS.ur],
          ["UL−LL", d.ulLl, ADC_ROLE_BORDER_DASH.ul, ROLE_COLORS.ul],
          ["UR−LL", d.urLl, ADC_ROLE_BORDER_DASH.ll, ROLE_COLORS.ll],
        ] as const
      ).map(([role, token, dash, color]) => ({
        key: `${slot}-d-${role}`,
        label: `${slot} ${role}`,
        points: chartDataMap.get(token) || [],
        color,
        borderDash: [...dash],
      })),
    };
  }

  const refSelections = useMemo(
    () => REF_CHECKBOXES.filter((r) => selectedRefIds.has(r.id)),
    [selectedRefIds]
  );

  const refOverlaySeries: OverlaySeries[] = useMemo(() => {
    return refSelections.map((r, i) => ({
      key: r.id,
      label: r.label,
      points: chartDataMap.get(r.token) || [],
      color: SERIES_PALETTE[i % SERIES_PALETTE.length],
      column: r.col,
    }));
  }, [refSelections, chartDataMap]);

  const manyRefs = refSelections.length > 4;
  const [expandRefTiles, setExpandRefTiles] = useState(false);
  const showRefIndividualStrip =
    refSelections.length > 0 && (!manyRefs || expandRefTiles);

  const refHeroHeight = refSelections.length > 8 ? 280 : refSelections.length > 4 ? 260 : 220;
  const refLegendMaxH = refSelections.length > 6 ? 88 : refSelections.length > 3 ? 72 : undefined;

  const sensorDiffData = useMemo(() => {
    if (diffSlotA === diffSlotB) return null;
    const ur = sensorSingleEndedDiff(chartDataMap, diffSlotA, diffSlotB, "ur");
    const ul = sensorSingleEndedDiff(chartDataMap, diffSlotA, diffSlotB, "ul");
    const ll = sensorSingleEndedDiff(chartDataMap, diffSlotA, diffSlotB, "ll");
    const overlay: OverlaySeries[] = [
      { key: "sd-ul", label: `UL (${diffSlotA}−${diffSlotB})`, points: ul, color: ROLE_COLORS.ul, borderDash: [...ADC_ROLE_BORDER_DASH.ul] },
      { key: "sd-ur", label: `UR (${diffSlotA}−${diffSlotB})`, points: ur, color: ROLE_COLORS.ur, borderDash: [...ADC_ROLE_BORDER_DASH.ur] },
      { key: "sd-ll", label: `LL (${diffSlotA}−${diffSlotB})`, points: ll, color: ROLE_COLORS.ll, borderDash: [...ADC_ROLE_BORDER_DASH.ll] },
    ];
    return { ur, ul, ll, overlay };
  }, [chartDataMap, diffSlotA, diffSlotB]);

  const combRefDiffData = useMemo(() => {
    if (combRefA === combRefB) return null;
    const refMetaA = REF_CHECKBOXES.find((r) => r.id === combRefA) ?? REF_CHECKBOXES[0];
    const refMetaB = REF_CHECKBOXES.find((r) => r.id === combRefB) ?? REF_CHECKBOXES[1];
    const ptsA = chartDataMap.get(refMetaA.token) || [];
    const ptsB = chartDataMap.get(refMetaB.token) || [];

    const bByLoop = new Map<number, number>();
    for (const p of ptsB) {
      const v = p[refMetaB.col] as number;
      if (Number.isFinite(v)) bByLoop.set(p.loopCounter, v);
    }

    const out: DataRow[] = [];
    for (const p of ptsA) {
      const bVal = bByLoop.get(p.loopCounter);
      if (bVal === undefined) continue;
      const aVal = p[refMetaA.col] as number;
      if (!Number.isFinite(aVal)) continue;
      out.push({ ...p, col6: aVal - bVal });
    }
    return { points: out, labelA: refMetaA.label, labelB: refMetaB.label };
  }, [chartDataMap, combRefA, combRefB]);

  const getHeartbeat = useCallback(
    (ec: number) => resolveHeartbeatMagnitudeByCounter(ec, dataConfigEntries),
    [dataConfigEntries]
  );

  const lossPerSlot = useMemo(() => {
    const map = new Map<string, { ur: LossResult[]; ul: LossResult[]; ll: LossResult[] }>();
    for (const slot of slotsSorted) {
      const triplet = adcTripletForSlot(slot);
      const dataCol = slotDataColumn(slot);
      const urPts = chartDataMap.get(triplet.ur) || [];
      const ulPts = chartDataMap.get(triplet.ul) || [];
      const llPts = chartDataMap.get(triplet.ll) || [];
      map.set(slot, {
        ur: computeLossPerEvent(urPts, dataCol, getHeartbeat),
        ul: computeLossPerEvent(ulPts, dataCol, getHeartbeat),
        ll: computeLossPerEvent(llPts, dataCol, getHeartbeat),
      });
    }
    return map;
  }, [slotsSorted, chartDataMap, getHeartbeat]);

  const lossPerRef = useMemo(() => {
    const map = new Map<string, { label: string; results: LossResult[] }>();
    for (const ref of refSelections) {
      const pts = chartDataMap.get(ref.token) || [];
      const results = computeLossPerEvent(pts, ref.col, getHeartbeat);
      map.set(ref.id, { label: ref.label.toUpperCase(), results });
    }
    return map;
  }, [refSelections, chartDataMap, getHeartbeat]);

  const dacFPoints = chartDataMap.get(DAC_F_TOKEN) || [];

  const hasSlots = slotsSorted.length > 0;

  const showRefBlock = refSelections.length > 0 || showSingleEndedRE || showPH;

  return (
    <div className="raw-display-wrap">
      <div className="raw-main-with-rail">
        <div className="raw-chart-blocks">
          {!hasSlots && (
            <div className="raw-empty-hint">
              Select at least one sensor slot (e.g. 1A) in the panel below.
            </div>
          )}

          {showSingleEnded && hasSlots && (
            <section className="chart-section">
              <h3 className="chart-section-title">Single-ended (ADC)</h3>
              <div className="chart-color-key">
                <span className="color-key-group">
                  <span className="color-key-title">Lines:</span>
                  <span className="color-key-item">
                    <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ul }} />UL (solid)
                  </span>
                  <span className="color-key-item">
                    <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ur }} />UR (solid)
                  </span>
                  <span className="color-key-item">
                    <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ll }} />LL (solid)
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
              {slotsSorted.map((slot) => {
                const se = seSeriesForSlot(slot);
                const dataCol = slotDataColumn(slot);
                return (
                  <div key={slot} className="raw-slot-block">
                    <div className="raw-slot-block-label">{slot}</div>
                    <div className="raw-row raw-row-4">
                      <OverlayChart pageTitle="Raw Data"
                        title={`${slot} UL`}
                        series={[se.ul]}
                        column={dataCol}
                        height={200}
                        showLegend={false}
                        colorByEvent
                        eventLabels={eventLabels}
                        resolveEventVisual={resolvePointEventVisual}
                        onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                      />
                      <OverlayChart pageTitle="Raw Data"
                        title={`${slot} UR`}
                        series={[se.ur]}
                        column={dataCol}
                        height={200}
                        showLegend={false}
                        colorByEvent
                        eventLabels={eventLabels}
                        resolveEventVisual={resolvePointEventVisual}
                        onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                      />
                      <OverlayChart pageTitle="Raw Data"
                        title={`${slot} LL`}
                        series={[se.ll]}
                        column={dataCol}
                        height={200}
                        showLegend={false}
                        colorByEvent
                        eventLabels={eventLabels}
                        resolveEventVisual={resolvePointEventVisual}
                        onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                      />
                      <OverlayChart pageTitle="Raw Data"
                        title={`${slot} overlaid`}
                        series={se.overlay}
                        column={dataCol}
                        height={200}
                        onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                      />
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {showSingleEnded && hasSlots && (() => {
            const allLossEvents = new Set<number>();
            for (const [, loss] of lossPerSlot) {
              for (const r of loss.ur) allLossEvents.add(r.eventCounter);
              for (const r of loss.ul) allLossEvents.add(r.eventCounter);
              for (const r of loss.ll) allLossEvents.add(r.eventCounter);
            }
            for (const [, refLoss] of lossPerRef) {
              for (const r of refLoss.results) allLossEvents.add(r.eventCounter);
            }
            const sortedLossEvents = Array.from(allLossEvents).sort((a, b) => a - b);
            const lossEventVisuals = sortedLossEvents.map((ec) =>
              resolveEventVisualByCounter(ec, eventLabels, dataConfigEntries)
            );

            return (
              <section className="chart-section loss-section">
                <h3 className="chart-section-title">Loss (%) per Event</h3>
                <button type="button" disabled={!sortedLossEvents.length} onClick={(e) => {
                  const table = e.currentTarget.closest("section")?.querySelector("table");
                  if (table) downloadLossTable(table);
                }}>Download Excel table</button>
                <div className="loss-heatmap-key" aria-label="Loss color scale">
                  <span>Loss (%) color scale:</span>
                  {[0.70, 0.75, 0.85, 0.95, 1].map((value) => (
                    <span key={value} style={{ backgroundColor: lossHeatmapColor(value), color: lossHeatmapTextColor(value), padding: "4px 8px" }}>
                      {value === 0.70 ? "≤ " : value === 1 ? "≥ " : ""}{value.toFixed(2)}%
                    </span>
                  ))}
                </div>
                <p className="chart-section-hint">
                  Loss = (Avg<sub>high</sub> − Avg<sub>low</sub>) / heartbeatMagnitude × 100%.
                  Avg Output = mean ADC value across all points in the event.
                  Requires DataConfig.csv with heartbeatMagnitude.
                </p>
                {sortedLossEvents.length === 0 ? (
                  <p className="raw-empty-hint">
                    No loss data — check that the heartbeat signal toggles on/off across events.
                  </p>
                ) : (
                  <div className="loss-table-wrap">
                    <table className="loss-table loss-table--pivoted">
                      <thead>
                        <tr>
                          <th rowSpan={2}>Sensor</th>
                          <th rowSpan={2}>ISFET</th>
                          {lossEventVisuals.map((ev, i) => (
                            <th key={sortedLossEvents[i]} colSpan={2} className="loss-event-header">
                              <span className="color-key-dot" style={{ backgroundColor: ev.color }} />
                              {ev.caption}
                            </th>
                          ))}
                        </tr>
                        <tr>
                          {sortedLossEvents.map((ec) => (
                            <React.Fragment key={ec}>
                              <th className="loss-sub-header loss-event-start">Avg Output</th>
                              <th className="loss-sub-header">Loss (%)</th>
                            </React.Fragment>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {slotsSorted.map((slot) => {
                          const loss = lossPerSlot.get(slot);
                          if (!loss) return null;
                          const urMap = new Map(loss.ur.map((r) => [r.eventCounter, r]));
                          const ulMap = new Map(loss.ul.map((r) => [r.eventCounter, r]));
                          const llMap = new Map(loss.ll.map((r) => [r.eventCounter, r]));
                          const roles: [string, Map<number, LossResult>][] = [
                            ["UL", ulMap],
                            ["UR", urMap],
                            ["LL", llMap],
                          ];
                          return roles.map(([role, rMap], ri) => (
                            <tr key={`${slot}-${role}`} className={ri === 0 ? "loss-group-start" : undefined}>
                              {ri === 0 && <td rowSpan={3} className="loss-sensor-cell">{slot}</td>}
                              <td className="loss-role-cell">{role}</td>
                              {sortedLossEvents.map((ec) => {
                                const r = rMap.get(ec);
                                return (
                                  <React.Fragment key={ec}>
                                    <td className="loss-val loss-event-start">{r ? r.avgOutput.toFixed(6) : "—"}</td>
                                    <td className="loss-val" style={r ? { backgroundColor: lossHeatmapColor(r.loss), color: lossHeatmapTextColor(r.loss) } : undefined}>{r ? r.loss.toFixed(4) : "—"}</td>
                                  </React.Fragment>
                                );
                              })}
                            </tr>
                          ));
                        })}
                        {Array.from(lossPerRef.entries()).map(([refId, refLoss]) => {
                          const rMap = new Map(refLoss.results.map((r) => [r.eventCounter, r]));
                          return (
                            <tr key={refId} className="loss-group-start">
                              <td className="loss-sensor-cell">{refLoss.label}</td>
                              <td className="loss-role-cell">—</td>
                              {sortedLossEvents.map((ec) => {
                                const r = rMap.get(ec);
                                return (
                                  <React.Fragment key={ec}>
                                    <td className="loss-val loss-event-start">{r ? r.avgOutput.toFixed(6) : "—"}</td>
                                    <td className="loss-val" style={r ? { backgroundColor: lossHeatmapColor(r.loss), color: lossHeatmapTextColor(r.loss) } : undefined}>{r ? r.loss.toFixed(4) : "—"}</td>
                                  </React.Fragment>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })()}

          {showDiff && hasSlots && (
            <section className="chart-section">
              <h3 className="chart-section-title">Differential</h3>
              <div className="chart-color-key">
                <span className="color-key-group">
                  <span className="color-key-title">Lines:</span>
                  <span className="color-key-item">
                    <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ul }} />UL−LL (solid)
                  </span>
                  <span className="color-key-item">
                    <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ur }} />UR−UL (solid)
                  </span>
                  <span className="color-key-item">
                    <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ll }} />UR−LL (solid)
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
              {slotsSorted.map((slot) => {
                const df = diffSeriesForSlot(slot);
                const dataCol = slotDataColumn(slot);
                return (
                  <div key={`d-${slot}`} className="raw-slot-block">
                    <div className="raw-slot-block-label">{slot}</div>
                    <div className="raw-row raw-row-4">
                      <OverlayChart pageTitle="Raw Data"
                        title={`${slot} UR−UL`}
                        series={[df.urUl]}
                        column={dataCol}
                        height={200}
                        showLegend={false}
                        colorByEvent
                        eventLabels={eventLabels}
                        resolveEventVisual={resolvePointEventVisual}
                        onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                      />
                      <OverlayChart pageTitle="Raw Data"
                        title={`${slot} UL−LL`}
                        series={[df.ulLl]}
                        column={dataCol}
                        height={200}
                        showLegend={false}
                        colorByEvent
                        eventLabels={eventLabels}
                        resolveEventVisual={resolvePointEventVisual}
                        onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                      />
                      <OverlayChart pageTitle="Raw Data"
                        title={`${slot} UR−LL`}
                        series={[df.urLl]}
                        column={dataCol}
                        height={200}
                        showLegend={false}
                        colorByEvent
                        eventLabels={eventLabels}
                        resolveEventVisual={resolvePointEventVisual}
                        onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                      />
                      <OverlayChart pageTitle="Raw Data"
                        title={`${slot} DIFFs overlaid`}
                        series={df.overlay}
                        column={dataCol}
                        height={200}
                        onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                      />
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          <section className="chart-section">
            <h3 className="chart-section-title">Sensor Difference (single-ended)</h3>
            <p className="chart-section-hint">
              Select two sensors to display the pointwise difference of their single-ended (ADC) data.
            </p>
            <div className="sensor-diff-pickers">
              <div className="sensor-diff-picker-group">
                <span className="sensor-diff-label">Sensor A</span>
                <SlotPicker value={diffSlotA} onChange={setDiffSlotA} />
              </div>
              <span className="sensor-diff-minus">−</span>
              <div className="sensor-diff-picker-group">
                <span className="sensor-diff-label">Sensor B</span>
                <SlotPicker value={diffSlotB} onChange={setDiffSlotB} />
              </div>
            </div>
            {diffSlotA === diffSlotB ? (
              <div className="raw-empty-hint">Select two different sensors to see their difference.</div>
            ) : sensorDiffData ? (
              <>
                <div className="chart-color-key">
                  <span className="color-key-group">
                    <span className="color-key-title">Lines ({diffSlotA} − {diffSlotB}):</span>
                    <span className="color-key-item">
                      <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ul }} />UL (solid)
                    </span>
                    <span className="color-key-item">
                      <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ur }} />UR (solid)
                    </span>
                    <span className="color-key-item">
                      <span className="color-key-line" style={{ borderColor: ROLE_COLORS.ll }} />LL (solid)
                    </span>
                  </span>
                </div>
                <div className="raw-slot-block">
                  <div className="raw-slot-block-label">{diffSlotA} − {diffSlotB}</div>
                  <div className="raw-row raw-row-4">
                    <OverlayChart pageTitle="Raw Data"
                      title={`UL: ${diffSlotA} − ${diffSlotB}`}
                      series={[{ key: "sd-ul", label: `UL diff`, points: sensorDiffData.ul, color: ROLE_COLORS.ul, borderDash: [...ADC_ROLE_BORDER_DASH.ul] }]}
                      column={VALUE_COL}
                      height={200}
                      showLegend={false}
                      colorByEvent
                      eventLabels={eventLabels}
                      resolveEventVisual={resolvePointEventVisual}
                      onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                    />
                    <OverlayChart pageTitle="Raw Data"
                      title={`UR: ${diffSlotA} − ${diffSlotB}`}
                      series={[{ key: "sd-ur", label: `UR diff`, points: sensorDiffData.ur, color: ROLE_COLORS.ur, borderDash: [...ADC_ROLE_BORDER_DASH.ur] }]}
                      column={VALUE_COL}
                      height={200}
                      showLegend={false}
                      colorByEvent
                      eventLabels={eventLabels}
                      resolveEventVisual={resolvePointEventVisual}
                      onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                    />
                    <OverlayChart pageTitle="Raw Data"
                      title={`LL: ${diffSlotA} − ${diffSlotB}`}
                      series={[{ key: "sd-ll", label: `LL diff`, points: sensorDiffData.ll, color: ROLE_COLORS.ll, borderDash: [...ADC_ROLE_BORDER_DASH.ll] }]}
                      column={VALUE_COL}
                      height={200}
                      showLegend={false}
                      colorByEvent
                      eventLabels={eventLabels}
                      resolveEventVisual={resolvePointEventVisual}
                      onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                    />
                    <OverlayChart pageTitle="Raw Data"
                      title={`${diffSlotA} − ${diffSlotB} overlaid`}
                      series={sensorDiffData.overlay}
                      column={VALUE_COL}
                      height={200}
                      onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                    />
                  </div>
                </div>
              </>
            ) : null}
          </section>

          {showRefBlock && (
            <section className="chart-section ref-chart-section">
              {refSelections.length > 0 ? (
              <div className="ref-section-head">
                <h3 className="chart-section-title">Reference electrodes</h3>
                <span className="ref-section-badge">{refSelections.length} selected</span>
                {manyRefs && (
                  <button
                    type="button"
                    className="ref-strip-toggle"
                    onClick={() => setExpandRefTiles((v) => !v)}
                  >
                    {expandRefTiles ? "Hide individual charts" : "Show individual charts"}
                  </button>
                )}
              </div>
              ) : (
                <div className="ref-section-head">
                  <h3 className="chart-section-title">Other channels</h3>
                </div>
              )}

              {refSelections.length > 0 && (
                <div className="ref-hero-wrap">
                  <OverlayChart pageTitle="Raw Data"
                    title="All selected REFs"
                    series={refOverlaySeries}
                    column={VALUE_COL}
                    height={refHeroHeight}
                    legendMaxHeight={refLegendMaxH}
                    colorByEvent={refSelections.length === 1}
                    eventLabels={eventLabels}
                    resolveEventVisual={resolvePointEventVisual}
                    onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                  />
                </div>
              )}

              {showRefIndividualStrip && (
                <>
                  <div className="ref-strip-label">Per-electrode view (scroll horizontally)</div>
                  <div className="ref-tiles-scroll">
                    {refSelections.map((r, i) => (
                      <div key={r.id} className="ref-tile-card">
                        <OverlayChart pageTitle="Raw Data"
                          title={r.label}
                          series={[
                            {
                              key: r.id,
                              label: r.label,
                              points: chartDataMap.get(r.token) || [],
                              color: SERIES_PALETTE[i % SERIES_PALETTE.length],
                              column: r.col,
                            },
                          ]}
                          column={VALUE_COL}
                          height={190}
                          colorByEvent
                          eventLabels={eventLabels}
                          resolveEventVisual={resolvePointEventVisual}
                          showLegend={false}
                          onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="comb-ph-electrode-section">
                <h4 className="comb-ph-section-title">Combination pH Electrode</h4>
                <div className="comb-ph-selectors">
                  <label className="comb-ph-sel-group">
                    <span className="comb-ph-sel-label">REF A</span>
                    <select
                      className="cal-select"
                      value={combRefA}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => setCombRefA(e.target.value as RefCheckId)}
                    >
                      {REF_CHECKBOXES.map((r) => (
                        <option key={r.id} value={r.id}>{r.label}</option>
                      ))}
                    </select>
                  </label>
                  <span className="comb-ph-minus">−</span>
                  <label className="comb-ph-sel-group">
                    <span className="comb-ph-sel-label">REF B</span>
                    <select
                      className="cal-select"
                      value={combRefB}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => setCombRefB(e.target.value as RefCheckId)}
                    >
                      {REF_CHECKBOXES.map((r) => (
                        <option key={r.id} value={r.id}>{r.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {combRefA === combRefB ? (
                  <div className="raw-empty-hint">Select two different REF channels to see their difference.</div>
                ) : combRefDiffData && combRefDiffData.points.length > 0 ? (
                  <OverlayChart pageTitle="Raw Data"
                    title={`${combRefDiffData.labelA} − ${combRefDiffData.labelB}`}
                    series={[
                      {
                        key: "comb-ph-diff",
                        label: `${combRefDiffData.labelA} − ${combRefDiffData.labelB}`,
                        points: combRefDiffData.points,
                        color: "#7c3aed",
                      },
                    ]}
                    column={VALUE_COL}
                    height={220}
                    colorByEvent
                    eventLabels={eventLabels}
                    resolveEventVisual={resolvePointEventVisual}
                    onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                  />
                ) : (
                  <div className="raw-empty-hint">No matching data for the selected REF channels.</div>
                )}
              </div>

              {(showSingleEndedRE || showPH) && (
                <div className="ref-aux-row">
                  {showSingleEndedRE && (
                    <OverlayChart pageTitle="Raw Data"
                      title="Heartbeat Signal"
                      series={[
                        {
                          key: "dac-f",
                          label: "Heartbeat",
                          points: dacFPoints,
                          color: "#64748b",
                        },
                      ]}
                      column={VALUE_COL}
                      height={160}
                      showLegend={false}
                      onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                    />
                  )}
                  {showPH && (
                    <div className="probe-chart chart-placeholder ph-placeholder" style={{ height: 160 }}>
                      <span>pH — add a pH token to the stream when available</span>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

        </div>

        <aside className="raw-rail">
          <h4 className="raw-rail-title">TEMP / CURR</h4>
          {Array.from(tempCols)
            .sort((a, b) => a - b)
            .map((n, i) => {
              const ts = resolveTemperatureSeries(chartDataMap, n);
              const title =
                ts.subtitle.length > 0
                  ? `TEMP ch ${n} · ${ts.subtitle}`
                  : `TEMP ch ${n}`;
              return (
                <OverlayChart pageTitle="Raw Data"
                  key={`temp-${n}`}
                  title={title}
                  series={[
                    {
                      key: `temp-${n}`,
                      label: `TEMP ${n}`,
                      points: ts.points,
                      color: SERIES_PALETTE[i % SERIES_PALETTE.length],
                    },
                  ]}
                  column={ts.yColumn}
                  colorByEvent
                  eventLabels={eventLabels}
                  resolveEventVisual={resolvePointEventVisual}
                  height={190}
                  showLegend={false}
                  yUnit=""
                  onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                />
              );
            })}
          {Array.from(currCols)
            .sort((a, b) => a - b)
            .map((n, i) => (
              <OverlayChart pageTitle="Raw Data"
                key={`curr-${n}`}
                title={`|CURR| col ${n}`}
                series={[
                  {
                    key: `curr-${n}`,
                    label: `CURR`,
                    points: chartDataMap.get(CURR_TOKEN) || [],
                    color: SERIES_PALETTE[(i + 2) % SERIES_PALETTE.length],
                  },
                ]}
                column={colKey(n)}
                absoluteValues
                colorByEvent
                eventLabels={eventLabels}
                resolveEventVisual={resolvePointEventVisual}
                height={190}
                showLegend={false}
                yUnit="A"
                onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
              />
            ))}
          {tempCols.size === 0 && currCols.size === 0 && (
            <p className="raw-rail-empty">Check TEMP or CURR columns to plot here.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
