import { useCallback, useMemo, useState, type ChangeEvent } from "react";
import {
  adcTripletForSlot,
  REF_CHECKBOXES,
  ADC_ROLE_BORDER_DASH,
  SERIES_PALETTE,
  slotDataColumn,
  type RefCheckId,
} from "../utils/sensorLayout";
import { deriveSingleEndedMinusRef } from "../utils/singleEndedREMath";
import { type DataRow, getEventColor } from "../utils/csvParser";
import SlotPicker from "./SlotPicker";
import {
  buildEventLatestTimestamps,
  resolveEventVisual,
  resolveEventVisualByCounter,
  type DataConfigRowParsed,
} from "../utils/dataConfigCsv";
import { getDataTimeBounds, elapsedMs } from "../utils/dataTimeBounds";
import OverlayChart, { type OverlaySeries } from "./OverlayChart";
import EventLegend from "./EventLegend";
import { SlidingWindowAndTimePanel } from "./SlidingWindowPanel";
import type { CalibrationEntry, CombPHCalibrationEntry, ISFETRole } from "../utils/calibrationStore";

const VALUE_COL: keyof DataRow = "col6";
const NEUTRAL_LINE = "#94a3b8";
const ROLE_COLORS: Record<ISFETRole, string> = { UR: "#ef4444", UL: "#3b82f6", LL: "#22c55e" };
const ROLES: ISFETRole[] = ["UL", "UR", "LL"];

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

export interface PHRowConfig {
  id: string;
  slot: string;
  loss: string;
  refId: RefCheckId;
  calibrationId: string;
}

function newRowId(): string {
  return `ph-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function refMeta(id: RefCheckId) {
  return REF_CHECKBOXES.find((r) => r.id === id) ?? REF_CHECKBOXES[0];
}

function parseLoss(s: string): number {
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0.9;
}

/**
 * Apply pH transform: pH = (DAC force - offset) / sensitivity.
 * deriveSingleEndedMinusRef already computes (ADC/loss - REF) into col6,
 * so we invert the calibration line DAC force = sensitivity * pH + offset.
 */
function derivePH(
  adcPoints: DataRow[],
  loss: number,
  refPoints: DataRow[],
  refCol: keyof DataRow,
  sensitivity: number,
  offset: number,
  adcCol: keyof DataRow = "col6"
): DataRow[] {
  const dacForce = deriveSingleEndedMinusRef(adcPoints, loss, refPoints, refCol, adcCol);
  if (Math.abs(sensitivity) < 1e-15) return dacForce;
  return dacForce.map((p) => ({
    ...p,
    col6: (p.col6 - offset) / sensitivity,
  }));
}

interface PHPageProps {
  windowedTokenMap: Map<string, DataRow[]>;
  windowSize: number;
  onWindowSizeChange: (n: number) => void;
  events: number[];
  eventLabels: Map<number, string>;
  hiddenEvents: Set<number>;
  onToggleEvent: (evt: number) => void;
  onSetHiddenEvents?: (hidden: Set<number>) => void;
  rows: PHRowConfig[];
  onRowsChange: (rows: PHRowConfig[]) => void;
  isPolling: boolean;
  onTogglePolling: () => void;
  totalRows: number;
  mode: string;
  dataConfigEntries?: readonly DataConfigRowParsed[];
  calibrationEntries: CalibrationEntry[];
  combPHEntries: CombPHCalibrationEntry[];
  allEventsLatestTimestamp?: Map<number, number>;
  onRangeSelect?: (startMs: number, endMs: number) => void;
  globalDenoise?: boolean;
  denoiseParams?: import("../utils/denoise").DenoiseParams;
  combRefAId: RefCheckId;
  onCombRefAIdChange: (v: RefCheckId) => void;
  combRefBId: RefCheckId;
  onCombRefBIdChange: (v: RefCheckId) => void;
  combSelectedCalId: string;
  onCombSelectedCalIdChange: (v: string) => void;
}

export default function PHPage({
  windowedTokenMap,
  windowSize,
  onWindowSizeChange,
  events,
  eventLabels,
  hiddenEvents,
  onToggleEvent,
  onSetHiddenEvents,
  rows,
  onRowsChange: setRows,
  isPolling,
  onTogglePolling,
  totalRows,
  mode,
  dataConfigEntries = [],
  calibrationEntries,
  combPHEntries,
  allEventsLatestTimestamp,
  onRangeSelect,
  globalDenoise,
  denoiseParams,
  combRefAId: combPHRefA,
  onCombRefAIdChange: setCombPHRefA,
  combRefBId: combPHRefB,
  onCombRefBIdChange: setCombPHRefB,
  combSelectedCalId: combPHCalId,
  onCombSelectedCalIdChange: setCombPHCalId,
}: PHPageProps) {
  
  const [timeLowRatio, setTimeLowRatio] = useState(0);
  const [timeHighRatio, setTimeHighRatio] = useState(1);
  const [diffEntryA, setDiffEntryA] = useState(0);
  const [diffEntryB, setDiffEntryB] = useState(1);

  const dataTimeBounds = useMemo(
    () => getDataTimeBounds(windowedTokenMap),
    [windowedTokenMap]
  );

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
        out.set(k, pts.filter((p) => { const t = elapsedMs(p); return t >= lo && t <= hi; }));
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

  const calMap = useMemo(() => {
    const m = new Map<string, CalibrationEntry>();
    for (const e of calibrationEntries) m.set(e.id, e);
    return m;
  }, [calibrationEntries]);

  /** Calibration options filtered per sensor slot. */
  const calibrationOptionsForSlot = useCallback(
    (slot: string) =>
      calibrationEntries
        .filter((e) => e.sensor === slot)
        .map((e) => ({ id: e.id, label: e.label })),
    [calibrationEntries]
  );

  const rowDerived = useMemo(() => {
    return rows.map((row, ri) => {
      const rowColor = SERIES_PALETTE[ri % SERIES_PALETTE.length];
      const loss = parseLoss(row.loss);
      const ref = refMeta(row.refId);
      const triplet = adcTripletForSlot(row.slot);
      const adcCol = slotDataColumn(row.slot);
      const refPts = chartDataMap.get(ref.token) || [];
      const cal = calMap.get(row.calibrationId);

      const results: Record<ISFETRole, DataRow[]> = { UL: [], UR: [], LL: [] };
      const overlaySeries: OverlaySeries[] = [];

      for (const role of ROLES) {
        const tokenKey =
          role === "UL" ? triplet.ul : role === "UR" ? triplet.ur : triplet.ll;
        const adcPts = chartDataMap.get(tokenKey) || [];
        const sensitivity = cal ? parseFloat(cal.values[role].sensitivity) || 0 : 0;
        const offset = cal ? parseFloat(cal.values[role].offset) || 0 : 0;

        results[role] = derivePH(adcPts, loss, refPts, ref.col, sensitivity, offset, adcCol);

        const dashMap: Record<ISFETRole, number[]> = {
          UR: [...ADC_ROLE_BORDER_DASH.ur],
          UL: [...ADC_ROLE_BORDER_DASH.ul],
          LL: [...ADC_ROLE_BORDER_DASH.ll],
        };

        overlaySeries.push({
          key: `${row.id}-${role}`,
          label: role,
          points: results[role],
          color: ROLE_COLORS[role],
          borderDash: dashMap[role],
        });
      }

      const shortRef = ref.label.replace(/^REF\s+/i, "");
      const calLabel = cal?.label ?? "no cal";
      return {
        row,
        rowColor,
        refLabel: ref.label,
        calLabel,
        titles: {
          ul: `${row.slot} UL pH (${calLabel})`,
          ur: `${row.slot} UR pH (${calLabel})`,
          ll: `${row.slot} LL pH (${calLabel})`,
          ov: `${row.slot} pH − ${shortRef} overlaid`,
        },
        results,
        overlaySeries,
      };
    });
  }, [rows, chartDataMap, calMap]);

  const bigOverlaySeries: OverlaySeries[] = useMemo(() => {
    const list: OverlaySeries[] = [];
    for (const d of rowDerived) {
      for (const role of ROLES) {
        list.push({
          key: `${d.row.id}-${role}`,
          label: `${d.row.slot} ${role} (${d.calLabel})`,
          points: d.results[role],
          color: d.rowColor,
          borderDash:
            role === "UR"
              ? [...ADC_ROLE_BORDER_DASH.ur]
              : role === "UL"
                ? [...ADC_ROLE_BORDER_DASH.ul]
                : [...ADC_ROLE_BORDER_DASH.ll],
        });
      }
    }
    return list;
  }, [rowDerived]);

  const entryDiffData = useMemo(() => {
    const a = rowDerived[diffEntryA];
    const b = rowDerived[diffEntryB];
    if (!a || !b || diffEntryA === diffEntryB) return null;
    const ur = pointwiseDiff(a.results.UR, b.results.UR);
    const ul = pointwiseDiff(a.results.UL, b.results.UL);
    const ll = pointwiseDiff(a.results.LL, b.results.LL);
    const refA = REF_CHECKBOXES.find((r) => r.id === a.row.refId)?.label ?? a.row.refId;
    const refB = REF_CHECKBOXES.find((r) => r.id === b.row.refId)?.label ?? b.row.refId;
    const labelA = `${a.row.slot} L${a.row.loss} ${refA} (${a.calLabel})`;
    const labelB = `${b.row.slot} L${b.row.loss} ${refB} (${b.calLabel})`;
    const overlay: OverlaySeries[] = [
      { key: "pd-ul", label: "UL", points: ul, color: ROLE_COLORS.UL, borderDash: [...ADC_ROLE_BORDER_DASH.ul] },
      { key: "pd-ur", label: "UR", points: ur, color: ROLE_COLORS.UR, borderDash: [...ADC_ROLE_BORDER_DASH.ur] },
      { key: "pd-ll", label: "LL", points: ll, color: ROLE_COLORS.LL, borderDash: [...ADC_ROLE_BORDER_DASH.ll] },
    ];
    return { ur, ul, ll, overlay, labelA, labelB };
  }, [rowDerived, diffEntryA, diffEntryB]);

  const combPHDerivedData = useMemo(() => {
    const cal = combPHEntries.find((e) => e.id === combPHCalId);
    if (!cal) return null;
    const sensitivity = parseFloat(cal.sensitivity);
    const offset = parseFloat(cal.offset);
    if (!Number.isFinite(sensitivity) || Math.abs(sensitivity) < 1e-15) return null;

    const refMetaA = REF_CHECKBOXES.find((r) => r.id === combPHRefA) ?? REF_CHECKBOXES[0];
    const refMetaB = REF_CHECKBOXES.find((r) => r.id === combPHRefB) ?? REF_CHECKBOXES[1];
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
      const diff = aVal - bVal;
      const ph = (diff - offset) / sensitivity;
      out.push({ ...p, col6: ph });
    }

    return { points: out, label: `pH (${refMetaA.label} − ${refMetaB.label})` };
  }, [chartDataMap, combPHRefA, combPHRefB, combPHCalId, combPHEntries]);

  const updateRow = (id: string, patch: Partial<PHRowConfig>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addSensorLine = useCallback(() => {
    setRows((prev) => {
      const last = prev[prev.length - 1];
      return [
        ...prev,
        {
          id: newRowId(),
          slot: last?.slot ?? "6A",
          loss: last?.loss ?? "0.9",
          refId: last?.refId ?? "ref-1a",
          calibrationId: last?.calibrationId ?? calibrationEntries[0]?.id ?? "",
        },
      ];
    });
  }, [calibrationEntries]);

  const removeSensorLine = useCallback((id: string) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
  }, []);

  return (
    <div className="ph-page">
      <div className="ph-chart-area">
        <div className="chart-color-key">
          <span className="color-key-group">
            <span className="color-key-title">Lines:</span>
            <span className="color-key-item">
              <span className="color-key-line" style={{ borderColor: ROLE_COLORS.UL }} />UL (solid)
            </span>
            <span className="color-key-item">
              <span className="color-key-line" style={{ borderColor: ROLE_COLORS.UR }} />UR (solid)
            </span>
            <span className="color-key-item">
              <span className="color-key-line" style={{ borderColor: ROLE_COLORS.LL }} />LL (solid)
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
        <div className="ph-small-grid">
          {rowDerived.map((d) => (
            <div key={d.row.id} className="ph-row-charts">
              <OverlayChart pageTitle="pH"
                title={d.titles.ul}
                series={[
                  {
                    key: "ul",
                    label: d.titles.ul,
                    points: d.results.UL,
                    color: ROLE_COLORS.UL,
                    borderDash: [...ADC_ROLE_BORDER_DASH.ul],
                  },
                ]}
                column={VALUE_COL}
                height={200}
                showLegend={false}
                yUnit="pH"
                colorByEvent
                eventLabels={eventLabels}
                resolveEventVisual={resolvePointEventVisual}
                onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
              />
              <OverlayChart pageTitle="pH"
                title={d.titles.ur}
                series={[
                  {
                    key: "ur",
                    label: d.titles.ur,
                    points: d.results.UR,
                    color: ROLE_COLORS.UR,
                    borderDash: [...ADC_ROLE_BORDER_DASH.ur],
                  },
                ]}
                column={VALUE_COL}
                height={200}
                showLegend={false}
                yUnit="pH"
                colorByEvent
                eventLabels={eventLabels}
                resolveEventVisual={resolvePointEventVisual}
                onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
              />
              <OverlayChart pageTitle="pH"
                title={d.titles.ll}
                series={[
                  {
                    key: "ll",
                    label: d.titles.ll,
                    points: d.results.LL,
                    color: ROLE_COLORS.LL,
                    borderDash: [...ADC_ROLE_BORDER_DASH.ll],
                  },
                ]}
                column={VALUE_COL}
                height={200}
                showLegend={false}
                yUnit="pH"
                colorByEvent
                eventLabels={eventLabels}
                resolveEventVisual={resolvePointEventVisual}
                onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
              />
              <OverlayChart pageTitle="pH"
                title={d.titles.ov}
                series={d.overlaySeries}
                column={VALUE_COL}
                height={200}
                yUnit="pH"
                onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
              />
            </div>
          ))}
        </div>

        {rows.length >= 2 && (
          <section className="entry-diff-section">
            <h3 className="entry-diff-title">pH Difference Between Entries</h3>
            <p className="entry-diff-hint">
              Select two entries to display the pointwise pH difference.
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
                    const cal = calMap.get(row.calibrationId);
                    return (
                      <option key={row.id} value={i}>
                        {row.slot} · loss {row.loss} · {ref?.label ?? row.refId} · {cal?.label ?? "no cal"}
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
                    const cal = calMap.get(row.calibrationId);
                    return (
                      <option key={row.id} value={i}>
                        {row.slot} · loss {row.loss} · {ref?.label ?? row.refId} · {cal?.label ?? "no cal"}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
            {!entryDiffData ? (
              <div className="entry-diff-empty">Select two different entries to see their pH difference.</div>
            ) : (
              <div className="entry-diff-charts">
                <OverlayChart pageTitle="pH"
                  title={`UL pH diff`}
                  series={[{ key: "pd-ul", label: "UL", points: entryDiffData.ul, color: ROLE_COLORS.UL, borderDash: [...ADC_ROLE_BORDER_DASH.ul] }]}
                  column={VALUE_COL}
                  height={200}
                  showLegend={false}
                  yUnit="pH"
                  colorByEvent
                  eventLabels={eventLabels}
                  resolveEventVisual={resolvePointEventVisual}
                  onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                />
                <OverlayChart pageTitle="pH"
                  title={`UR pH diff`}
                  series={[{ key: "pd-ur", label: "UR", points: entryDiffData.ur, color: ROLE_COLORS.UR, borderDash: [...ADC_ROLE_BORDER_DASH.ur] }]}
                  column={VALUE_COL}
                  height={200}
                  showLegend={false}
                  yUnit="pH"
                  colorByEvent
                  eventLabels={eventLabels}
                  resolveEventVisual={resolvePointEventVisual}
                  onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                />
                <OverlayChart pageTitle="pH"
                  title={`LL pH diff`}
                  series={[{ key: "pd-ll", label: "LL", points: entryDiffData.ll, color: ROLE_COLORS.LL, borderDash: [...ADC_ROLE_BORDER_DASH.ll] }]}
                  column={VALUE_COL}
                  height={200}
                  showLegend={false}
                  yUnit="pH"
                  colorByEvent
                  eventLabels={eventLabels}
                  resolveEventVisual={resolvePointEventVisual}
                  onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                />
                <OverlayChart pageTitle="pH"
                  title={`pH difference overlaid`}
                  series={entryDiffData.overlay}
                  column={VALUE_COL}
                  height={200}
                  yUnit="pH"
                  onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
                />
              </div>
            )}
          </section>
        )}

        <section className="comb-ph-display-section">
          <h3 className="entry-diff-title">Combination pH Electrode</h3>
          <div className="comb-ph-selectors">
            <label className="comb-ph-sel-group">
              <span className="comb-ph-sel-label">REF A</span>
              <select
                className="cal-select"
                value={combPHRefA}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setCombPHRefA(e.target.value as RefCheckId)}
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
                value={combPHRefB}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setCombPHRefB(e.target.value as RefCheckId)}
              >
                {REF_CHECKBOXES.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </label>
            <label className="comb-ph-sel-group">
              <span className="comb-ph-sel-label">Calibration</span>
              <select
                className="cal-select"
                value={combPHCalId}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setCombPHCalId(e.target.value)}
              >
                <option value="">— none —</option>
                {combPHEntries.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
            </label>
          </div>
          {!combPHCalId ? (
            <div className="entry-diff-empty">Select a combination pH calibration to display derived pH.</div>
          ) : combPHDerivedData && combPHDerivedData.points.length > 0 ? (
            <OverlayChart pageTitle="pH"
              title={combPHDerivedData.label}
              series={[
                {
                  key: "comb-ph",
                  label: combPHDerivedData.label,
                  points: combPHDerivedData.points,
                  color: "#7c3aed",
                },
              ]}
              column={VALUE_COL}
              height={240}
              yUnit="pH"
              colorByEvent
              eventLabels={eventLabels}
              resolveEventVisual={resolvePointEventVisual}
              onRangeSelect={onRangeSelect} globalDenoise={globalDenoise} denoiseParams={denoiseParams}
            />
          ) : (
            <div className="entry-diff-empty">No derived pH data — check that REF data and calibration are available.</div>
          )}
        </section>
      </div>

      <div className="ph-bottom-deck">
        <div className="ph-deck-col ph-deck-config">
          <h4 className="ph-deck-heading">
            Sensor / loss / Reference / Sensitivities &amp; Offset
          </h4>
          <div className="ph-config-table">
            {rows.map((row) => {
              const calOpts = calibrationOptionsForSlot(row.slot);
              return (
                <div key={row.id} className="ph-config-row">
                  <SlotPicker
                    value={row.slot}
                    onChange={(slot) => updateRow(row.id, { slot, calibrationId: "" })}
                  />
                  <div className="se-re-config-fields">
                    <label className="se-re-field-label">
                      Loss
                      <input
                        type="text"
                        className="ph-loss-input"
                        value={row.loss}
                        onChange={(e) => updateRow(row.id, { loss: e.target.value })}
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
                    <label className="se-re-field-label">
                      Calibration
                      <select
                        className="ph-select"
                        value={row.calibrationId}
                        onChange={(e) =>
                          updateRow(row.id, { calibrationId: e.target.value })
                        }
                      >
                        <option value="">— none —</option>
                        {calOpts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="ph-remove-btn"
                      disabled={rows.length <= 1}
                      onClick={() => removeSensorLine(row.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="ph-config-footer-actions">
            <button type="button" className="ph-add-btn" onClick={addSensorLine}>
              + Add sensor
            </button>
          </div>
          <p className="ph-formula-hint">
            pH = (ADC<sub>col6</sub> &divide; loss &minus; REF &minus; offset) &divide; sensitivity
          </p>
        </div>

        <div className="ph-deck-col ph-deck-events">
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

        <div className="ph-deck-col ph-deck-window">
          <h4 className="ph-deck-heading">Time sliding window</h4>
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
            rangeInputId="ph-window-range"
          />
          {mode === "live" && (
            <div className="ph-live-mini">
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
