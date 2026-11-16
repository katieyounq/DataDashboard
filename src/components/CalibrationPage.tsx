import { useCallback, useMemo, useRef, useState, useEffect, type ChangeEvent } from "react";
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  BarElement,
  LinearScale,
  CategoryScale,
  Title,
  Tooltip,
  Legend,
  type ChartOptions,
  type ChartData,
} from "chart.js";
import { Scatter, Bar } from "react-chartjs-2";
import {
  adcTripletForSlot,
  REF_CHECKBOXES,
  SERIES_PALETTE,
  slotDataColumn,
  type RefCheckId,
} from "../utils/sensorLayout";
import { deriveSingleEndedMinusRef } from "../utils/singleEndedREMath";
import type { DataRow } from "../utils/csvParser";
import { denoiseDataRows, type DenoiseParams, DEFAULT_DENOISE_PARAMS } from "../utils/denoise";
import {
  resolveEventVisual,
  type DataConfigRowParsed,
} from "../utils/dataConfigCsv";
import {
  type CalibrationEntry,
  type CalibrationPoint,
  type ISFETRole,
  type CombPHCalibrationEntry,
  type TargetCalibrationEntry,
  type FourPLParams,
  linearRegression,
  fit4PL,
  makeCalibrationLabel,
  makeCombPHLabel,
  makeTargetCalibrationLabel,
  newEntryId,
  nextCalibrationNumber,
  nextCombPHCalibrationNumber,
  nextTargetCalibrationNumber,
} from "../utils/calibrationStore";
import SlotPicker from "./SlotPicker";

ChartJS.register(LineElement, PointElement, BarElement, LinearScale, CategoryScale, Title, Tooltip, Legend);

const ROLES: ISFETRole[] = ["UL", "UR", "LL"];

const CONCENTRATION_UNITS = [
  { key: "aM", label: "aM (1e-18)", multiplier: 1e-18 },
  { key: "fM", label: "fM (1e-15)", multiplier: 1e-15 },
  { key: "pM", label: "pM (1e-12)", multiplier: 1e-12 },
  { key: "nM", label: "nM (1e-9)", multiplier: 1e-9 },
  { key: "µM", label: "µM (1e-6)", multiplier: 1e-6 },
  { key: "mM", label: "mM (1e-3)", multiplier: 1e-3 },
  { key: "M", label: "M (1e0)", multiplier: 1 },
] as const;

function unitMultiplier(key: string): number {
  return CONCENTRATION_UNITS.find((u) => u.key === key)?.multiplier ?? 1;
}

export interface CalibrationFormState {
  calSensor: string;
  calLoss: string;
  calRefId: RefCheckId;
  calPoints: CalibrationPoint[];
  regressionResults: Record<ISFETRole, RegressionResult | null>;
  hasCalibrated: boolean;
  addSensor: string;
}

interface CalibrationPageProps {
  windowedTokenMap: Map<string, DataRow[]>;
  events: number[];
  eventLabels: Map<number, string>;
  dataConfigEntries?: readonly DataConfigRowParsed[];
  calibrationEntries: CalibrationEntry[];
  onCalibrationEntriesChange: (entries: CalibrationEntry[]) => void;
  formState: CalibrationFormState;
  onFormStateChange: (s: CalibrationFormState) => void;
  allEventsLatestTimestamp?: Map<number, number>;
  combPHEntries: CombPHCalibrationEntry[];
  onCombPHEntriesChange: (entries: CombPHCalibrationEntry[]) => void;
  /** All data filters – user selects which to apply during calibration. */
  dataFilters?: import("../utils/dataFilters").DataFilter[];
  targetCalEntries: TargetCalibrationEntry[];
  onTargetCalEntriesChange: (entries: TargetCalibrationEntry[]) => void;
  denoiseParams?: DenoiseParams;
  /* Lifted target calibration state (Task 5) */
  tcSensors: string[];
  onTcSensorsChange: (v: string[]) => void;
  tcLoss: string;
  onTcLossChange: (v: string) => void;
  tcRefId: RefCheckId;
  onTcRefIdChange: (v: RefCheckId) => void;
  tcPoints: TargetCalPoint[];
  onTcPointsChange: (v: TargetCalPoint[]) => void;
}

function newPointId(): string {
  return `pt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function refMeta(id: RefCheckId) {
  return REF_CHECKBOXES.find((r) => r.id === id) ?? REF_CHECKBOXES[0];
}

function parseLoss(s: string): number {
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0.9;
}

/**
 * For a given event, compute the average (ADC/loss - REF) value across all
 * data points matching that event for a single ADC channel.
 * When `dnParams` is provided, the ADC and REF data are denoised before derivation.
 */
function avgDacForceForEvent(
  adcPoints: DataRow[],
  loss: number,
  refPoints: DataRow[],
  refCol: keyof DataRow,
  eventCounter: number,
  adcCol: keyof DataRow = "col6",
  dnParams?: DenoiseParams,
): number | null {
  const adc = dnParams ? denoiseDataRows(adcPoints, adcCol, dnParams) : adcPoints;
  const ref = dnParams ? denoiseDataRows(refPoints, refCol, dnParams) : refPoints;
  const derived = deriveSingleEndedMinusRef(adc, loss, ref, refCol, adcCol);
  const matching = derived.filter((p) => p.eventCounter === eventCounter);
  if (matching.length === 0) return null;
  const sum = matching.reduce((acc, p) => acc + p.col6, 0);
  return sum / matching.length;
}

export interface ScatterPoint {
  x: number;
  y: number;
}

export interface RegressionResult {
  slope: number;
  intercept: number;
  r2: number;
  points: ScatterPoint[];
}

/**
 * Combined regression chart: X = pH, Y = Avg(fnOut/loss − RE).
 * All three ISFETs (UL, UR, LL) on one chart with separate regression lines.
 *
 * The regression is computed as DAC force = slope * pH + intercept,
 * so the slope is the visual slope of the graph (sensitivity).
 */
function CombinedRegressionChart({
  results,
  visibleRoles = ROLES,
}: {
  results: Record<ISFETRole, RegressionResult | null>;
  visibleRoles?: ISFETRole[];
}) {
  const ROLE_COLORS: Record<ISFETRole, string> = {
    UL: SERIES_PALETTE[0],
    UR: SERIES_PALETTE[1],
    LL: SERIES_PALETTE[2],
  };

  const datasets: ChartData<"scatter">["datasets"] = [];

  const allPHs: number[] = [];
  for (const role of visibleRoles) {
    const r = results[role];
    if (!r || r.points.length === 0) continue;
    for (const p of r.points) allPHs.push(p.x);
  }
  if (allPHs.length === 0) return null;

  const phMin = Math.min(...allPHs);
  const phMax = Math.max(...allPHs);
  const pad = (phMax - phMin) * 0.15 || 0.5;
  const linePhLo = phMin - pad;
  const linePhHi = phMax + pad;

  for (const role of visibleRoles) {
    const r = results[role];
    if (!r || r.points.length === 0) continue;
    const color = ROLE_COLORS[role];

    datasets.push({
      label: `${role}`,
      data: r.points.map((p) => ({ x: p.x, y: p.y })),
      backgroundColor: color,
      borderColor: color,
      pointRadius: 6,
      pointHoverRadius: 8,
      showLine: false,
    });

    if (Math.abs(r.slope) > 1e-15 || Math.abs(r.intercept) > 1e-15) {
      const bfAtLo = r.slope * linePhLo + r.intercept;
      const bfAtHi = r.slope * linePhHi + r.intercept;
      datasets.push({
        label: `${role} fit (R²=${r.r2.toFixed(4)})`,
        data: [
          { x: linePhLo, y: bfAtLo },
          { x: linePhHi, y: bfAtHi },
        ],
        borderColor: color,
        borderWidth: 2,
        borderDash: [6, 3],
        pointRadius: 0,
        showLine: true,
        fill: false,
      });
    }
  }

  const options: ChartOptions<"scatter"> = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        title: { display: true, text: "pH", font: { size: 12 } },
        grid: { color: "rgba(0,0,0,0.06)" },
      },
      y: {
        title: { display: true, text: "Avg(fnOut / loss − RE)", font: { size: 12 } },
        grid: { color: "rgba(0,0,0,0.06)" },
      },
    },
    plugins: {
      legend: {
        display: true,
        position: "bottom",
        labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } },
      },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const pt = ctx.raw as ScatterPoint;
            return `${ctx.dataset.label}: pH=${pt.x.toFixed(2)}, Avg=${pt.y.toFixed(4)}`;
          },
        },
      },
    },
  };

  return (
    <div className="cal-regression-chart-combined">
      <Scatter data={{ datasets }} options={options} />
    </div>
  );
}

const COMPARISON_COLORS = [
  "#2563eb", "#dc2626", "#16a34a", "#ca8a04", "#9333ea",
  "#db2777", "#0891b2", "#ea580c", "#6366f1", "#84cc16",
];

function CalibrationComparisonChart({
  entries,
  field,
  title,
  yLabel,
}: {
  entries: CalibrationEntry[];
  field: "sensitivity" | "offset" | "r2";
  title: string;
  yLabel: string;
}) {
  if (entries.length === 0) return null;

  const labels = ROLES;
  const datasets = entries.map((entry, i) => ({
    label: entry.label,
    data: ROLES.map((role) => {
      const v = parseFloat(entry.values[role][field]);
      return Number.isFinite(v) ? v : 0;
    }),
    backgroundColor: COMPARISON_COLORS[i % COMPARISON_COLORS.length],
  }));

  const options: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        type: "category" as const,
        title: { display: true, text: "ISFET", font: { size: 12 } },
        grid: { color: "rgba(0,0,0,0.06)" },
      },
      y: {
        title: { display: true, text: yLabel, font: { size: 12 } },
        grid: { color: "rgba(0,0,0,0.06)" },
      },
    },
    plugins: {
      legend: {
        display: true,
        position: "bottom",
        labels: { usePointStyle: true, boxWidth: 10, font: { size: 11 } },
      },
      title: {
        display: true,
        text: title,
        font: { size: 14 },
      },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(6) ?? "—"}`,
        },
      },
    },
  };

  return (
    <div className="cal-comparison-chart">
      <Bar data={{ labels, datasets }} options={options} />
    </div>
  );
}

/* ── Target Analyte Concentration Calibration Section ── */

export interface TargetCalPoint {
  id: string;
  eventCounters: number[];
  concentrationValue: string;
  concentrationUnit: string;
}

function newTargetPointId(): string {
  return `tcp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function FourPLChart({
  results,
  visibleRoles = ROLES,
}: {
  results: Record<ISFETRole, { params: FourPLParams; points: ScatterPoint[] } | null>;
  visibleRoles?: ISFETRole[];
}) {
  const ROLE_COLORS_4PL: Record<ISFETRole, string> = {
    UL: SERIES_PALETTE[0],
    UR: SERIES_PALETTE[1],
    LL: SERIES_PALETTE[2],
  };

  const datasets: ChartData<"scatter">["datasets"] = [];
  const allXs: number[] = [];
  for (const role of visibleRoles) {
    const r = results[role];
    if (!r || r.points.length === 0) continue;
    for (const p of r.points) allXs.push(p.x);
  }
  if (allXs.length === 0) return null;

  const xMin = Math.min(...allXs);
  const xMax = Math.max(...allXs);
  const pad = (xMax - xMin) * 0.15 || 0.5;
  const lo = xMin - pad;
  const hi = xMax + pad;

  for (const role of visibleRoles) {
    const r = results[role];
    if (!r || r.points.length === 0) continue;
    const color = ROLE_COLORS_4PL[role];

    datasets.push({
      label: `${role}`,
      data: r.points.map((p) => ({ x: p.x, y: p.y })),
      backgroundColor: color,
      borderColor: color,
      pointRadius: 6,
      pointHoverRadius: 8,
      showLine: false,
    });

    const { a, b, c, d } = r.params;
    const curvePoints: { x: number; y: number }[] = [];
    const steps = 100;
    for (let i = 0; i <= steps; i++) {
      const x = lo + (hi - lo) * (i / steps);
      const logX = x;
      const conc = Math.pow(10, logX);
      const ratio = conc / c;
      const y = ratio > 0 ? d + (a - d) / (1 + Math.pow(ratio, b)) : d + (a - d);
      curvePoints.push({ x, y });
    }
    datasets.push({
      label: `${role} fit (R²=${r.params.r2.toFixed(4)})`,
      data: curvePoints,
      borderColor: color,
      borderWidth: 2,
      borderDash: [6, 3],
      pointRadius: 0,
      showLine: true,
      fill: false,
    });
  }

  const options: ChartOptions<"scatter"> = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        title: { display: true, text: "log₁₀(Concentration) (M)", font: { size: 12 } },
        grid: { color: "rgba(0,0,0,0.06)" },
      },
      y: {
        title: { display: true, text: "Avg(ADC / loss − REF)", font: { size: 12 } },
        grid: { color: "rgba(0,0,0,0.06)" },
      },
    },
    plugins: {
      legend: {
        display: true,
        position: "bottom",
        labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } },
      },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const pt = ctx.raw as ScatterPoint;
            return `${ctx.dataset.label}: log₁₀(c)=${pt.x.toFixed(3)}, Avg=${pt.y.toFixed(4)}`;
          },
        },
      },
    },
  };

  return (
    <div className="cal-regression-chart-combined">
      <Scatter data={{ datasets }} options={options} />
    </div>
  );
}

function TargetCalibrationSection({
  windowedTokenMap,
  events,
  eventCaptions,
  targetCalEntries,
  onTargetCalEntriesChange,
  tcSensors,
  onTcSensorsChange,
  tcLoss,
  onTcLossChange,
  tcRefId,
  onTcRefIdChange,
  tcPoints,
  onTcPointsChange,
  dnParams,
}: {
  windowedTokenMap: Map<string, DataRow[]>;
  events: number[];
  eventCaptions: Map<number, string>;
  targetCalEntries: TargetCalibrationEntry[];
  onTargetCalEntriesChange: (entries: TargetCalibrationEntry[]) => void;
  tcSensors: string[];
  onTcSensorsChange: (v: string[]) => void;
  tcLoss: string;
  onTcLossChange: (v: string) => void;
  tcRefId: RefCheckId;
  onTcRefIdChange: (v: RefCheckId) => void;
  tcPoints: TargetCalPoint[];
  onTcPointsChange: (v: TargetCalPoint[]) => void;
  dnParams?: DenoiseParams;
}) {
  const [tcSensor, setTcSensor] = useState("6A");
  const [tcResults, setTcResults] = useState<Record<ISFETRole, { params: FourPLParams; points: ScatterPoint[] } | null>>({
    UL: null, UR: null, LL: null,
  });
  const [tcHasCalibrated, setTcHasCalibrated] = useState(false);
  const [tcVisibleRoles, setTcVisibleRoles] = useState<ISFETRole[]>([...ROLES]);

  // Sensor difference mode (Task 6)
  const [tcMode, setTcMode] = useState<"single" | "difference">("single");
  const [tcSensorB, setTcSensorB] = useState("6C");
  const [tcSensorsB, setTcSensorsB] = useState<string[]>(["6C"]);
  const [tcLossB, setTcLossB] = useState("0.9");
  const [tcRefIdB, setTcRefIdB] = useState<RefCheckId>("ref-1a");

  const tcImportRef = useRef<HTMLInputElement | null>(null);

  const setTcSensors = onTcSensorsChange;
  const setTcLoss = onTcLossChange;
  const setTcRefId = onTcRefIdChange;
  const setTcPoints = onTcPointsChange;

  const handleAddSensor = useCallback(() => {
    if (!tcSensors.includes(tcSensor)) {
      setTcSensors([...tcSensors, tcSensor]);
    }
    setTcHasCalibrated(false);
  }, [tcSensor, tcSensors, setTcSensors]);

  const handleRemoveSensor = useCallback((slot: string) => {
    setTcSensors(tcSensors.filter((s) => s !== slot));
    setTcHasCalibrated(false);
  }, [tcSensors, setTcSensors]);

  const handleAddSensorB = useCallback(() => {
    if (!tcSensorsB.includes(tcSensorB)) {
      setTcSensorsB((prev) => [...prev, tcSensorB]);
    }
    setTcHasCalibrated(false);
  }, [tcSensorB, tcSensorsB]);

  const handleRemoveSensorB = useCallback((slot: string) => {
    setTcSensorsB((prev) => prev.filter((s) => s !== slot));
    setTcHasCalibrated(false);
  }, []);

  const handleCalibrate = useCallback(() => {
    const loss = parseLoss(tcLoss);
    const ref = refMeta(tcRefId);
    const refPts = windowedTokenMap.get(ref.token) || [];

    const lossB = parseLoss(tcLossB);
    const refB = refMeta(tcRefIdB);
    const refPtsB = windowedTokenMap.get(refB.token) || [];

    const validPoints = tcPoints.filter((p) => {
      const v = parseFloat(p.concentrationValue);
      return p.concentrationValue.trim() !== "" && Number.isFinite(v) && v > 0;
    });

    const results: Record<ISFETRole, { params: FourPLParams; points: ScatterPoint[] } | null> = {
      UL: null, UR: null, LL: null,
    };

    for (const role of ROLES) {
      const regPoints: { x: number; y: number }[] = [];

      for (const cp of validPoints) {
        const concVal = parseFloat(cp.concentrationValue);
        const conc = concVal * unitMultiplier(cp.concentrationUnit);
        const logConc = Math.log10(conc);

        if (tcMode === "single") {
          const allAvgs: number[] = [];
          for (const slot of tcSensors) {
            const triplet = adcTripletForSlot(slot);
            const adcCol = slotDataColumn(slot);
            const tokenKey = role === "UL" ? triplet.ul : role === "UR" ? triplet.ur : triplet.ll;
            const adcPts = windowedTokenMap.get(tokenKey) || [];

            for (const ec of cp.eventCounters) {
              const avg = avgDacForceForEvent(adcPts, loss, refPts, ref.col, ec, adcCol, dnParams);
              if (avg !== null) allAvgs.push(avg);
            }
          }

          if (allAvgs.length > 0) {
            const avgVal = allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length;
            regPoints.push({ x: logConc, y: avgVal });
          }
        } else {
          // Difference mode: Y = avg(sensorA_corrected) - avg(sensorB_corrected)
          const avgsA: number[] = [];
          for (const slot of tcSensors) {
            const triplet = adcTripletForSlot(slot);
            const adcCol = slotDataColumn(slot);
            const tokenKey = role === "UL" ? triplet.ul : role === "UR" ? triplet.ur : triplet.ll;
            const adcPts = windowedTokenMap.get(tokenKey) || [];
            for (const ec of cp.eventCounters) {
              const avg = avgDacForceForEvent(adcPts, loss, refPts, ref.col, ec, adcCol, dnParams);
              if (avg !== null) avgsA.push(avg);
            }
          }
          const avgsB: number[] = [];
          for (const slot of tcSensorsB) {
            const triplet = adcTripletForSlot(slot);
            const adcCol = slotDataColumn(slot);
            const tokenKey = role === "UL" ? triplet.ul : role === "UR" ? triplet.ur : triplet.ll;
            const adcPts = windowedTokenMap.get(tokenKey) || [];
            for (const ec of cp.eventCounters) {
              const avg = avgDacForceForEvent(adcPts, lossB, refPtsB, refB.col, ec, adcCol, dnParams);
              if (avg !== null) avgsB.push(avg);
            }
          }
          if (avgsA.length > 0 && avgsB.length > 0) {
            const meanA = avgsA.reduce((a, b) => a + b, 0) / avgsA.length;
            const meanB = avgsB.reduce((a, b) => a + b, 0) / avgsB.length;
            regPoints.push({ x: logConc, y: meanA - meanB });
          }
        }
      }

      const fitPoints = regPoints.map((p) => ({ x: Math.pow(10, p.x), y: p.y }));
      const fit = fit4PL(fitPoints);
      if (fit) {
        results[role] = { params: fit, points: regPoints };
      }
    }

    setTcResults(results);
    setTcHasCalibrated(true);
  }, [tcSensors, tcLoss, tcRefId, tcPoints, windowedTokenMap, tcMode, tcSensorsB, tcLossB, tcRefIdB, dnParams]);

  const handleSave = useCallback(() => {
    if (!tcHasCalibrated) return;
    const slotsLabel = tcMode === "difference" ? [...tcSensors, "−", ...tcSensorsB] : tcSensors;
    const num = nextTargetCalibrationNumber(targetCalEntries, tcSensors);
    const label = makeTargetCalibrationLabel(slotsLabel, num);
    const roles: TargetCalibrationEntry["roles"] = {};
    for (const role of ROLES) {
      const r = tcResults[role];
      roles[role] = {
        a: r ? r.params.a.toFixed(8) : "0",
        b: r ? r.params.b.toFixed(8) : "0",
        c: r ? r.params.c.toFixed(8) : "0",
        d: r ? r.params.d.toFixed(8) : "0",
        r2: r ? r.params.r2.toFixed(6) : "",
      };
    }
    const entry: TargetCalibrationEntry = {
      id: newEntryId(),
      calibrationNumber: num,
      label,
      sensorSlots: tcMode === "difference" ? [...tcSensors, "−", ...tcSensorsB] : [...tcSensors],
      refId: tcRefId,
      loss: parseLoss(tcLoss),
      roles,
    };
    onTargetCalEntriesChange([...targetCalEntries, entry]);
  }, [tcHasCalibrated, tcResults, tcSensors, tcSensorsB, tcMode, tcRefId, tcLoss, targetCalEntries, onTargetCalEntriesChange]);

  const handleRemoveEntry = useCallback(
    (id: string) => onTargetCalEntriesChange(targetCalEntries.filter((e) => e.id !== id)),
    [targetCalEntries, onTargetCalEntriesChange]
  );

  const handleEntryLabelChange = useCallback(
    (id: string, label: string) => {
      onTargetCalEntriesChange(targetCalEntries.map((e) => (e.id === id ? { ...e, label } : e)));
    },
    [targetCalEntries, onTargetCalEntriesChange]
  );

  const handleExport = useCallback(() => {
    if (targetCalEntries.length === 0) return;
    const lines: string[] = [];
    lines.push("Label,Sensors,Reference,Loss,ISFET,A,B,C,D,R2");
    for (const entry of targetCalEntries) {
      for (const role of ROLES) {
        const v = entry.roles[role];
        if (!v) continue;
        lines.push(
          `${entry.label},${entry.sensorSlots.join("+")},${entry.refId},${entry.loss},${role},${v.a},${v.b},${v.c},${v.d},${v.r2}`
        );
      }
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Target_Calibration_Table.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [targetCalEntries]);

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
        if (lines.length < 2) return;

        const entryMap = new Map<string, { slots: string[]; refId: string; loss: number; roles: TargetCalibrationEntry["roles"] }>();
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(",").map((s) => s.trim());
          if (parts.length < 10) continue;
          const [label, sensors, refId, lossStr, role, a, b, c, d, r2] = parts;
          if (!entryMap.has(label)) {
            entryMap.set(label, {
              slots: sensors.split("+"),
              refId,
              loss: parseFloat(lossStr) || 0.9,
              roles: {},
            });
          }
          const em = entryMap.get(label)!;
          em.roles[role] = { a, b, c, d, r2 };
        }

        const imported: TargetCalibrationEntry[] = [];
        for (const [label, data] of entryMap) {
          imported.push({
            id: newEntryId(),
            calibrationNumber: 0,
            label,
            sensorSlots: data.slots,
            refId: data.refId,
            loss: data.loss,
            roles: data.roles,
          });
        }
        if (imported.length > 0) {
          onTargetCalEntriesChange([...targetCalEntries, ...imported]);
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [targetCalEntries, onTargetCalEntriesChange]
  );

  const toggleTcVisibleRole = useCallback((role: ISFETRole) => {
    setTcVisibleRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  }, []);

  /* Helper to update a single point field */
  const updatePoint = useCallback((id: string, patch: Partial<TargetCalPoint>) => {
    setTcPoints(tcPoints.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setTcHasCalibrated(false);
  }, [tcPoints, setTcPoints]);

  return (
    <div className="cal-tool comb-ph-cal-section">
      <h3 className="cal-section-title">Target Analyte Concentration Calibration</h3>

      {/* Task 6: Mode toggle */}
      <div className="cal-tool-row" style={{ gap: 12, marginBottom: 8, padding: "0 16px" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13 }}>
          <input type="radio" name="tc-mode" checked={tcMode === "single"} onChange={() => { setTcMode("single"); setTcHasCalibrated(false); }} />
          Single Sensor
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13 }}>
          <input type="radio" name="tc-mode" checked={tcMode === "difference"} onChange={() => { setTcMode("difference"); setTcHasCalibrated(false); }} />
          Sensor Difference (A − B)
        </label>
      </div>

      <div className="cal-tool-controls">
        {/* Sensor A controls (or the only controls in single mode) */}
        <div className="cal-tool-row">
          <div className="cal-field">
            <span className="cal-field-label">{tcMode === "difference" ? "Add Sensor A" : "Add Sensor"}</span>
            <div style={{ display: "flex", gap: 6, alignItems: "start" }}>
              <SlotPicker value={tcSensor} onChange={setTcSensor} />
              <button type="button" className="cal-save-btn" style={{ marginTop: 0 }} onClick={handleAddSensor}>
                + Add
              </button>
            </div>
          </div>
          <label className="cal-field">
            <span className="cal-field-label">{tcMode === "difference" ? "Loss A" : "Loss"}</span>
            <input
              type="text"
              className="cal-input"
              value={tcLoss}
              onChange={(e) => { setTcLoss(e.target.value); setTcHasCalibrated(false); }}
              placeholder="0.9"
            />
          </label>
          <label className="cal-field">
            <span className="cal-field-label">{tcMode === "difference" ? "Reference A" : "Reference"}</span>
            <select
              className="cal-select"
              value={tcRefId}
              onChange={(e) => { setTcRefId(e.target.value as RefCheckId); setTcHasCalibrated(false); }}
            >
              {REF_CHECKBOXES.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </label>
        </div>

        {tcSensors.length > 0 && (
          <div className="cal-tool-row" style={{ gap: 6, flexWrap: "wrap" }}>
            <span className="cal-field-label" style={{ alignSelf: "center" }}>{tcMode === "difference" ? "Sensor A:" : "Selected sensors:"}</span>
            {tcSensors.map((slot) => (
              <span key={slot} style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "3px 10px", background: "var(--accent-light)",
                borderRadius: 14, fontSize: 12, fontWeight: 600, color: "var(--accent)",
              }}>
                {slot}
                <button type="button" style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: 14, lineHeight: 1, color: "var(--text-secondary)", padding: 0,
                }} onClick={() => handleRemoveSensor(slot)}>×</button>
              </span>
            ))}
          </div>
        )}

        {/* Sensor B controls (only in difference mode) */}
        {tcMode === "difference" && (
          <>
            <div className="cal-tool-row" style={{ marginTop: 8, borderTop: "1px dashed var(--border)", paddingTop: 8 }}>
              <div className="cal-field">
                <span className="cal-field-label">Add Sensor B</span>
                <div style={{ display: "flex", gap: 6, alignItems: "start" }}>
                  <SlotPicker value={tcSensorB} onChange={setTcSensorB} />
                  <button type="button" className="cal-save-btn" style={{ marginTop: 0 }} onClick={handleAddSensorB}>
                    + Add
                  </button>
                </div>
              </div>
              <label className="cal-field">
                <span className="cal-field-label">Loss B</span>
                <input
                  type="text"
                  className="cal-input"
                  value={tcLossB}
                  onChange={(e) => { setTcLossB(e.target.value); setTcHasCalibrated(false); }}
                  placeholder="0.9"
                />
              </label>
              <label className="cal-field">
                <span className="cal-field-label">Reference B</span>
                <select
                  className="cal-select"
                  value={tcRefIdB}
                  onChange={(e) => { setTcRefIdB(e.target.value as RefCheckId); setTcHasCalibrated(false); }}
                >
                  {REF_CHECKBOXES.map((r) => (
                    <option key={r.id} value={r.id}>{r.label}</option>
                  ))}
                </select>
              </label>
            </div>
            {tcSensorsB.length > 0 && (
              <div className="cal-tool-row" style={{ gap: 6, flexWrap: "wrap" }}>
                <span className="cal-field-label" style={{ alignSelf: "center" }}>Sensor B:</span>
                {tcSensorsB.map((slot) => (
                  <span key={slot} style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 10px", background: "#fde68a",
                    borderRadius: 14, fontSize: 12, fontWeight: 600, color: "#92400e",
                  }}>
                    {slot}
                    <button type="button" style={{
                      background: "none", border: "none", cursor: "pointer",
                      fontSize: 14, lineHeight: 1, color: "var(--text-secondary)", padding: 0,
                    }} onClick={() => handleRemoveSensorB(slot)}>×</button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <div className="cal-points">
          <div className="cal-points-header" style={{ gridTemplateColumns: "80px minmax(0,1fr) 80px 110px auto" }}>
            <span />
            <span>Event</span>
            <span>Value</span>
            <span>Unit</span>
            <span />
          </div>
          {tcPoints.map((pt, i) => (
            <div key={pt.id} className="cal-point-row cal-point-multi" style={{ gridTemplateColumns: "80px minmax(0,1fr) 80px 110px auto" }}>
              <span className="cal-point-label">Point {i + 1}</span>
              <div className="cal-event-list">
                {pt.eventCounters.map((ec, ei) => (
                  <div key={ei} className="cal-event-item">
                    <select
                      className="cal-select"
                      value={ec}
                      onChange={(e) => {
                        const updated = [...pt.eventCounters];
                        updated[ei] = Number(e.target.value);
                        updatePoint(pt.id, { eventCounters: updated });
                      }}
                    >
                      {events.map((ev) => (
                        <option key={ev} value={ev}>{eventCaptions.get(ev) ?? ev}</option>
                      ))}
                    </select>
                    {pt.eventCounters.length > 1 && (
                      <button
                        type="button"
                        className="cal-remove-event-btn"
                        onClick={() => updatePoint(pt.id, { eventCounters: pt.eventCounters.filter((_, j) => j !== ei) })}
                      >×</button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="cal-add-event-btn"
                  onClick={() => updatePoint(pt.id, { eventCounters: [...pt.eventCounters, events[0] ?? 1] })}
                >+ Event</button>
              </div>
              <input
                type="text"
                className="cal-input"
                style={{ width: 80 }}
                value={pt.concentrationValue}
                onChange={(e) => updatePoint(pt.id, { concentrationValue: e.target.value })}
                placeholder="10"
              />
              <select
                className="cal-select"
                style={{ width: 110 }}
                value={pt.concentrationUnit}
                onChange={(e) => updatePoint(pt.id, { concentrationUnit: e.target.value })}
              >
                {CONCENTRATION_UNITS.map((u) => (
                  <option key={u.key} value={u.key}>{u.label}</option>
                ))}
              </select>
              <button
                type="button"
                className="cal-remove-btn"
                disabled={tcPoints.length <= 1}
                onClick={() => {
                  setTcPoints(tcPoints.filter((p) => p.id !== pt.id));
                  setTcHasCalibrated(false);
                }}
              >Remove Point</button>
            </div>
          ))}
          <button
            type="button"
            className="cal-add-btn"
            onClick={() => {
              setTcPoints([...tcPoints, { id: newTargetPointId(), eventCounters: [events[0] ?? 1], concentrationValue: "", concentrationUnit: "nM" }]);
              setTcHasCalibrated(false);
            }}
          >+ Add point</button>
        </div>

        <div className="cal-actions">
          <button type="button" className="cal-calibrate-btn" onClick={handleCalibrate}>Calibrate</button>
          {tcHasCalibrated && (
            <button type="button" className="cal-save-btn" onClick={handleSave}>Save to table</button>
          )}
          {targetCalEntries.length > 0 && (
            <button type="button" className="cal-export-btn" onClick={handleExport}>Export Calibration</button>
          )}
          <button type="button" className="cal-import-btn" onClick={() => tcImportRef.current?.click()}>Import Calibration</button>
          <input ref={tcImportRef} type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={handleImport} />
          <button
            type="button"
            className="cal-new-btn"
            onClick={() => {
              setTcPoints([
                { id: newTargetPointId(), eventCounters: [events[0] ?? 1], concentrationValue: "1", concentrationUnit: "nM" },
                { id: newTargetPointId(), eventCounters: [events[1] ?? 2], concentrationValue: "10", concentrationUnit: "nM" },
                { id: newTargetPointId(), eventCounters: [events[2] ?? 3], concentrationValue: "100", concentrationUnit: "nM" },
                { id: newTargetPointId(), eventCounters: [events[3] ?? 4], concentrationValue: "1000", concentrationUnit: "nM" },
              ]);
              setTcResults({ UL: null, UR: null, LL: null });
              setTcHasCalibrated(false);
            }}
          >New Calibration</button>
        </div>
      </div>

      {tcHasCalibrated && (
        <div className="cal-results">
          <div className="cal-results-layout">
            <div className="cal-results-chart-panel">
              {/* Task 1: ISFET visibility checkboxes for 4PL chart */}
              <div style={{ display: "flex", gap: 10, padding: "4px 0 6px", fontSize: 12 }}>
                {ROLES.map((role) => (
                  <label key={role} style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={tcVisibleRoles.includes(role)}
                      onChange={() => toggleTcVisibleRole(role)}
                    />
                    {role}
                  </label>
                ))}
              </div>
              <FourPLChart results={tcResults} visibleRoles={tcVisibleRoles} />
            </div>
            <div className="cal-results-summary">
              <h4>4PL Parameters &amp; R²</h4>
              <table className="cal-r2-table">
                <thead>
                  <tr>
                    <th>ISFET</th>
                    <th>A (min)</th>
                    <th>B (Hill)</th>
                    <th>C (EC50)</th>
                    <th>D (max)</th>
                    <th>R²</th>
                  </tr>
                </thead>
                <tbody>
                  {ROLES.map((role) => {
                    const r = tcResults[role];
                    return (
                      <tr key={role}>
                        <td className="cal-r2-role">{role}</td>
                        <td>{r ? r.params.a.toFixed(6) : "—"}</td>
                        <td>{r ? r.params.b.toFixed(6) : "—"}</td>
                        <td>{r ? r.params.c.toFixed(6) : "—"}</td>
                        <td>{r ? r.params.d.toFixed(6) : "—"}</td>
                        <td>{r ? r.params.r2.toFixed(6) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {targetCalEntries.length > 0 && (
        <div className="cal-table-section" style={{ marginTop: 16, padding: "12px 16px" }}>
          <h4 className="cal-section-title">Saved Target Analyte Calibrations</h4>
          <div className="cal-table-wrap">
            <table className="cal-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Sensors</th>
                  <th>ISFET</th>
                  <th>A (min)</th>
                  <th>B (Hill)</th>
                  <th>C (EC50)</th>
                  <th>D (max)</th>
                  <th>R²</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {targetCalEntries.map((entry) =>
                  ROLES.map((role, ri) => {
                    const v = entry.roles[role];
                    return (
                      <tr key={`${entry.id}-${role}`} className={ri === 0 ? "cal-row-first" : ""}>
                        {ri === 0 && (
                          <>
                            <td rowSpan={3}>
                              <input
                                type="text"
                                className="cal-table-input"
                                value={entry.label}
                                onChange={(e) => handleEntryLabelChange(entry.id, e.target.value)}
                              />
                            </td>
                            <td rowSpan={3}>{entry.sensorSlots.join(", ")}</td>
                          </>
                        )}
                        <td className="cal-cell-isfet">{role}</td>
                        <td>{v?.a ?? "—"}</td>
                        <td>{v?.b ?? "—"}</td>
                        <td>{v?.c ?? "—"}</td>
                        <td>{v?.d ?? "—"}</td>
                        <td>{v?.r2 ?? "—"}</td>
                        {ri === 0 && (
                          <td rowSpan={3} className="cal-cell-actions">
                            <button type="button" className="cal-remove-btn" onClick={() => handleRemoveEntry(entry.id)}>Remove</button>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

interface CombPHCalPoint {
  id: string;
  eventCounter: number;
  ph: string;
}

function newCombPHPointId(): string {
  return `cpt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function avgRefDiffForEvent(
  refAPts: DataRow[],
  refACol: keyof DataRow,
  refBPts: DataRow[],
  refBCol: keyof DataRow,
  eventCounter: number,
  dnParams?: DenoiseParams,
): number | null {
  const ptsA = dnParams ? denoiseDataRows(refAPts, refACol, dnParams) : refAPts;
  const ptsB = dnParams ? denoiseDataRows(refBPts, refBCol, dnParams) : refBPts;
  const bByLoop = new Map<number, number>();
  for (const p of ptsB) {
    if (p.eventCounter === eventCounter) {
      const v = p[refBCol] as number;
      if (Number.isFinite(v)) bByLoop.set(p.loopCounter, v);
    }
  }
  let sum = 0, n = 0;
  for (const p of ptsA) {
    if (p.eventCounter !== eventCounter) continue;
    const bVal = bByLoop.get(p.loopCounter);
    if (bVal === undefined) continue;
    const aVal = p[refACol] as number;
    if (!Number.isFinite(aVal)) continue;
    sum += (aVal - bVal);
    n++;
  }
  return n > 0 ? sum / n : null;
}

function CombPHRegressionChart({
  points,
  slope,
  intercept,
  r2,
}: {
  points: { x: number; y: number }[];
  slope: number;
  intercept: number;
  r2: number;
}) {
  if (points.length === 0) return null;

  const allPHs = points.map((p) => p.x);
  const phMin = Math.min(...allPHs);
  const phMax = Math.max(...allPHs);
  const pad = (phMax - phMin) * 0.15 || 0.5;
  const linePhLo = phMin - pad;
  const linePhHi = phMax + pad;

  const datasets: ChartData<"scatter">["datasets"] = [
    {
      label: "Avg(REF_A − REF_B)",
      data: points.map((p) => ({ x: p.x, y: p.y })),
      backgroundColor: "#7c3aed",
      borderColor: "#7c3aed",
      pointRadius: 6,
      pointHoverRadius: 8,
      showLine: false,
    },
    {
      label: `Fit (R²=${r2.toFixed(4)})`,
      data: [
        { x: linePhLo, y: slope * linePhLo + intercept },
        { x: linePhHi, y: slope * linePhHi + intercept },
      ],
      borderColor: "#7c3aed",
      borderWidth: 2,
      borderDash: [6, 3],
      pointRadius: 0,
      showLine: true,
      fill: false,
    },
  ];

  const options: ChartOptions<"scatter"> = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        title: { display: true, text: "pH", font: { size: 12 } },
        grid: { color: "rgba(0,0,0,0.06)" },
      },
      y: {
        title: { display: true, text: "Avg(REF_A − REF_B)", font: { size: 12 } },
        grid: { color: "rgba(0,0,0,0.06)" },
      },
    },
    plugins: {
      legend: {
        display: true,
        position: "bottom",
        labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } },
      },
    },
  };

  return (
    <div className="cal-regression-chart-combined">
      <Scatter data={{ datasets }} options={options} />
    </div>
  );
}

function CombPHCalibrationSection({
  windowedTokenMap,
  events,
  eventCaptions,
  combPHEntries,
  onCombPHEntriesChange,
  dnParams,
}: {
  windowedTokenMap: Map<string, DataRow[]>;
  events: number[];
  eventCaptions: Map<number, string>;
  combPHEntries: CombPHCalibrationEntry[];
  onCombPHEntriesChange: (entries: CombPHCalibrationEntry[]) => void;
  dnParams?: DenoiseParams;
}) {
  const [combRefA, setCombRefA] = useState<RefCheckId>("ref-1a");
  const [combRefB, setCombRefB] = useState<RefCheckId>("ref-1b");
  const [combPoints, setCombPoints] = useState<CombPHCalPoint[]>([
    { id: newCombPHPointId(), eventCounter: events[0] ?? 1, ph: "7" },
    { id: newCombPHPointId(), eventCounter: events[1] ?? 2, ph: "4" },
  ]);
  const [combResult, setCombResult] = useState<{
    slope: number;
    intercept: number;
    r2: number;
    points: { x: number; y: number }[];
  } | null>(null);

  const refMetaA = REF_CHECKBOXES.find((r) => r.id === combRefA) ?? REF_CHECKBOXES[0];
  const refMetaB = REF_CHECKBOXES.find((r) => r.id === combRefB) ?? REF_CHECKBOXES[1];

  const handleCombCalibrate = useCallback(() => {
    const refAPts = windowedTokenMap.get(refMetaA.token) || [];
    const refBPts = windowedTokenMap.get(refMetaB.token) || [];

    const validPoints = combPoints.filter(
      (p) => p.ph.trim() !== "" && Number.isFinite(parseFloat(p.ph))
    );

    const regPoints: { x: number; y: number }[] = [];
    for (const cp of validPoints) {
      const avg = avgRefDiffForEvent(refAPts, refMetaA.col, refBPts, refMetaB.col, cp.eventCounter, dnParams);
      if (avg !== null) {
        regPoints.push({ x: parseFloat(cp.ph), y: avg });
      }
    }

    const reg = linearRegression(regPoints);
    if (reg) {
      setCombResult({ slope: reg.slope, intercept: reg.intercept, r2: reg.r2, points: regPoints });
    } else {
      setCombResult(null);
    }
  }, [combPoints, windowedTokenMap, refMetaA, refMetaB, dnParams]);

  const handleSaveCombPH = useCallback(() => {
    if (!combResult) return;
    const num = nextCombPHCalibrationNumber(combPHEntries, combRefA, combRefB);
    const label = makeCombPHLabel(refMetaA.label, refMetaB.label, num);
    const entry: CombPHCalibrationEntry = {
      id: newEntryId(),
      refAId: combRefA,
      refBId: combRefB,
      calibrationNumber: num,
      label,
      sensitivity: combResult.slope.toFixed(6),
      offset: combResult.intercept.toFixed(6),
      r2: combResult.r2.toFixed(6),
    };
    onCombPHEntriesChange([...combPHEntries, entry]);
  }, [combResult, combPHEntries, onCombPHEntriesChange, combRefA, combRefB, refMetaA, refMetaB]);

  const handleRemoveCombEntry = useCallback(
    (id: string) => onCombPHEntriesChange(combPHEntries.filter((e) => e.id !== id)),
    [combPHEntries, onCombPHEntriesChange]
  );

  const handleCombEntryLabelChange = useCallback(
    (id: string, label: string) => {
      onCombPHEntriesChange(combPHEntries.map((e) => (e.id === id ? { ...e, label } : e)));
    },
    [combPHEntries, onCombPHEntriesChange]
  );

  const combImportRef = useRef<HTMLInputElement | null>(null);

  const handleExportCombPH = useCallback(() => {
    if (combPHEntries.length === 0) return;
    const lines: string[] = [];
    lines.push("Label,REF_A,REF_B,R2,Sensitivity,Offset");
    for (const entry of combPHEntries) {
      const ra = REF_CHECKBOXES.find((r) => r.id === entry.refAId);
      const rb = REF_CHECKBOXES.find((r) => r.id === entry.refBId);
      lines.push(
        `${entry.label},${ra?.label ?? entry.refAId},${rb?.label ?? entry.refBId},${entry.r2},${entry.sensitivity},${entry.offset}`
      );
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "CombPH_Calibration_Table.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [combPHEntries]);

  const handleImportCombPH = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
        if (lines.length < 2) {
          alert("CSV file must have a header row and at least one data row.");
          return;
        }

        const imported: CombPHCalibrationEntry[] = [];
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(",").map((s) => s.trim());
          if (parts.length < 6) continue;
          const [label, refALabel, refBLabel, r2, sensitivity, offset] = parts;
          const refA = REF_CHECKBOXES.find((r) => r.label === refALabel);
          const refB = REF_CHECKBOXES.find((r) => r.label === refBLabel);
          imported.push({
            id: newEntryId(),
            refAId: refA?.id ?? "ref-1a",
            refBId: refB?.id ?? "ref-1b",
            calibrationNumber: 0,
            label,
            sensitivity,
            offset,
            r2,
          });
        }

        if (imported.length === 0) {
          alert("No valid calibration rows found in the imported file.");
          return;
        }
        onCombPHEntriesChange([...combPHEntries, ...imported]);
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [combPHEntries, onCombPHEntriesChange]
  );

  return (
    <div className="cal-tool comb-ph-cal-section">
      <h3 className="cal-section-title">Combination pH Electrode Calibration</h3>

      <div className="cal-tool-controls">
        <div className="cal-tool-row">
          <label className="cal-field">
            <span className="cal-field-label">REF A</span>
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
          <label className="cal-field">
            <span className="cal-field-label">REF B</span>
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

        <div className="cal-points">
          <div className="cal-points-header">
            <span />
            <span>Event</span>
            <span>pH</span>
            <span />
          </div>
          {combPoints.map((pt, i) => (
            <div key={pt.id} className="cal-point-row">
              <span className="cal-point-label">Point {i + 1}</span>
              <select
                className="cal-select"
                value={pt.eventCounter}
                onChange={(e) => {
                  setCombPoints((prev) =>
                    prev.map((p) =>
                      p.id === pt.id ? { ...p, eventCounter: Number(e.target.value) } : p
                    )
                  );
                  setCombResult(null);
                }}
              >
                {events.map((ev) => (
                  <option key={ev} value={ev}>
                    {eventCaptions.get(ev) ?? ev}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className="cal-input"
                value={pt.ph}
                onChange={(e) => {
                  setCombPoints((prev) =>
                    prev.map((p) =>
                      p.id === pt.id ? { ...p, ph: e.target.value } : p
                    )
                  );
                  setCombResult(null);
                }}
                placeholder="7.0"
              />
              <button
                type="button"
                className="cal-remove-btn"
                disabled={combPoints.length <= 1}
                onClick={() => {
                  setCombPoints((prev) => prev.filter((p) => p.id !== pt.id));
                  setCombResult(null);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="cal-add-btn"
            onClick={() => {
              setCombPoints((prev) => [
                ...prev,
                { id: newCombPHPointId(), eventCounter: events[0] ?? 1, ph: "7" },
              ]);
              setCombResult(null);
            }}
          >
            + Add point
          </button>
        </div>

        <div className="cal-actions">
          <button type="button" className="cal-calibrate-btn" onClick={handleCombCalibrate}>
            Calibrate
          </button>
          {combResult && (
            <button type="button" className="cal-save-btn" onClick={handleSaveCombPH}>
              Save to table
            </button>
          )}
          {combPHEntries.length > 0 && (
            <button type="button" className="cal-export-btn" onClick={handleExportCombPH}>
              Export Calibration
            </button>
          )}
          <button
            type="button"
            className="cal-import-btn"
            onClick={() => combImportRef.current?.click()}
          >
            Import Calibration
          </button>
          <input
            ref={combImportRef}
            type="file"
            accept=".csv,.txt"
            style={{ display: "none" }}
            onChange={handleImportCombPH}
          />
        </div>
      </div>

      {combResult && (
        <div className="cal-results">
          <div className="cal-results-layout">
            <div className="cal-results-chart-panel">
              <CombPHRegressionChart
                points={combResult.points}
                slope={combResult.slope}
                intercept={combResult.intercept}
                r2={combResult.r2}
              />
            </div>
            <div className="cal-results-summary">
              <h4>Combination pH Calibration Values</h4>
              <table className="cal-r2-table">
                <thead>
                  <tr>
                    <th>R²</th>
                    <th>Sensitivity (slope)</th>
                    <th>Offset (intercept)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{combResult.r2.toFixed(6)}</td>
                    <td>{combResult.slope.toFixed(6)}</td>
                    <td>{combResult.intercept.toFixed(6)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {combPHEntries.length > 0 && (
        <div className="cal-table-section">
          <h4 className="cal-section-title">Saved Combination pH Calibrations</h4>
          <div className="cal-table-wrap">
            <table className="cal-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>REF A</th>
                  <th>REF B</th>
                  <th>R²</th>
                  <th>Sensitivity</th>
                  <th>Offset</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {combPHEntries.map((entry) => {
                  const ra = REF_CHECKBOXES.find((r) => r.id === entry.refAId);
                  const rb = REF_CHECKBOXES.find((r) => r.id === entry.refBId);
                  return (
                    <tr key={entry.id}>
                      <td>
                        <input
                          type="text"
                          className="cal-table-input"
                          value={entry.label}
                          onChange={(e) => handleCombEntryLabelChange(entry.id, e.target.value)}
                        />
                      </td>
                      <td>{ra?.label ?? entry.refAId}</td>
                      <td>{rb?.label ?? entry.refBId}</td>
                      <td>{entry.r2}</td>
                      <td>{entry.sensitivity}</td>
                      <td>{entry.offset}</td>
                      <td>
                        <button
                          type="button"
                          className="cal-remove-btn"
                          onClick={() => handleRemoveCombEntry(entry.id)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CalibrationPage({
  windowedTokenMap,
  events,
  eventLabels,
  dataConfigEntries = [],
  calibrationEntries,
  onCalibrationEntriesChange,
  formState,
  onFormStateChange,
  allEventsLatestTimestamp,
  combPHEntries,
  onCombPHEntriesChange,
  dataFilters = [],
  targetCalEntries,
  onTargetCalEntriesChange,
  tcSensors,
  onTcSensorsChange,
  tcLoss,
  onTcLossChange,
  tcRefId,
  onTcRefIdChange,
  tcPoints,
  onTcPointsChange,
  denoiseParams,
}: CalibrationPageProps) {
  const [useDenoised, setUseDenoised] = useState(false);
  const effectiveDnParams = useDenoised ? (denoiseParams ?? DEFAULT_DENOISE_PARAMS) : undefined;

  const eventCaptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const ev of events) {
      const dataTs = allEventsLatestTimestamp?.get(ev);
      if (dataTs !== undefined) {
        m.set(ev, resolveEventVisual(dataTs, ev, eventLabels, dataConfigEntries).caption);
      } else if (eventLabels.has(ev)) {
        m.set(ev, `${ev} – ${eventLabels.get(ev)}`);
      } else {
        m.set(ev, `${ev}`);
      }
    }
    return m;
  }, [events, eventLabels, dataConfigEntries, allEventsLatestTimestamp]);

  const { calSensor, calLoss, calRefId, calPoints, regressionResults, hasCalibrated, addSensor } = formState;
  const patch = useCallback(
    (p: Partial<CalibrationFormState>) => onFormStateChange({ ...formState, ...p }),
    [formState, onFormStateChange],
  );
  const setCalSensor = useCallback((v: string) => patch({ calSensor: v }), [patch]);
  const setCalLoss = useCallback((v: string) => patch({ calLoss: v }), [patch]);
  const setCalRefId = useCallback((v: RefCheckId) => patch({ calRefId: v }), [patch]);
  const setCalPoints = useCallback(
    (fn: CalibrationPoint[] | ((prev: CalibrationPoint[]) => CalibrationPoint[])) =>
      onFormStateChange({
        ...formState,
        calPoints: typeof fn === "function" ? fn(formState.calPoints) : fn,
      }),
    [formState, onFormStateChange],
  );
  const setRegressionResults = useCallback(
    (v: Record<ISFETRole, RegressionResult | null>) => patch({ regressionResults: v }),
    [patch],
  );
  const setHasCalibrated = useCallback((v: boolean) => patch({ hasCalibrated: v }), [patch]);
  const setAddSensor = useCallback((v: string) => patch({ addSensor: v }), [patch]);

  const updatePoint = useCallback((id: string, ptPatch: Partial<CalibrationPoint>) => {
    onFormStateChange({
      ...formState,
      calPoints: formState.calPoints.map((p) => (p.id === id ? { ...p, ...ptPatch } : p)),
      hasCalibrated: false,
    });
  }, [formState, onFormStateChange]);

  const addPoint = useCallback(() => {
    onFormStateChange({
      ...formState,
      calPoints: [...formState.calPoints, { id: newPointId(), eventCounters: [events[0] ?? 1], ph: "7" }],
      hasCalibrated: false,
    });
  }, [events, formState, onFormStateChange]);

  const removePoint = useCallback((id: string) => {
    if (formState.calPoints.length <= 1) return;
    onFormStateChange({
      ...formState,
      calPoints: formState.calPoints.filter((p) => p.id !== id),
      hasCalibrated: false,
    });
  }, [formState, onFormStateChange]);

  const handleCalibrate = useCallback(() => {
    const loss = parseLoss(calLoss);
    const ref = refMeta(calRefId);
    const triplet = adcTripletForSlot(calSensor);
    const adcCol = slotDataColumn(calSensor);
    const refPts = windowedTokenMap.get(ref.token) || [];

    const validPoints = calPoints.filter(
      (p) => p.ph.trim() !== "" && Number.isFinite(parseFloat(p.ph))
    );

    const results: Record<ISFETRole, RegressionResult | null> = {
      UL: null,
      UR: null,
      LL: null,
    };

    for (const role of ROLES) {
      const tokenKey =
        role === "UL" ? triplet.ul : role === "UR" ? triplet.ur : triplet.ll;
      const adcPts = windowedTokenMap.get(tokenKey) || [];

      const regPoints: { x: number; y: number }[] = [];
      for (const cp of validPoints) {
        const bfValues: number[] = [];
        for (const ec of cp.eventCounters) {
          const avgBf = avgDacForceForEvent(adcPts, loss, refPts, ref.col, ec, adcCol, effectiveDnParams);
          if (avgBf !== null) bfValues.push(avgBf);
        }
        if (bfValues.length > 0) {
          const avgBf = bfValues.reduce((a, b) => a + b, 0) / bfValues.length;
          regPoints.push({ x: parseFloat(cp.ph), y: avgBf });
        }
      }

      const reg = linearRegression(regPoints);
      if (reg) {
        results[role] = { slope: reg.slope, intercept: reg.intercept, r2: reg.r2, points: regPoints };
      }
    }

    onFormStateChange({ ...formState, regressionResults: results, hasCalibrated: true });
  }, [calSensor, calLoss, calRefId, calPoints, windowedTokenMap, formState, onFormStateChange, effectiveDnParams]);

  const handleSaveCalibration = useCallback(() => {
    const num = nextCalibrationNumber(calibrationEntries, calSensor);
    const label = makeCalibrationLabel(calSensor, num);
    const mkVal = (r: RegressionResult | null) => ({
      sensitivity: r ? r.slope.toFixed(6) : "0",
      offset: r ? r.intercept.toFixed(6) : "0",
      r2: r ? r.r2.toFixed(6) : "",
    });
    const entry: CalibrationEntry = {
      id: newEntryId(),
      sensor: calSensor,
      calibrationNumber: num,
      label,
      values: {
        UL: mkVal(regressionResults.UL),
        UR: mkVal(regressionResults.UR),
        LL: mkVal(regressionResults.LL),
      },
    };
    onCalibrationEntriesChange([...calibrationEntries, entry]);
  }, [calSensor, calibrationEntries, onCalibrationEntriesChange, regressionResults]);

  const handleExportCalibration = useCallback(() => {
    const loss = parseLoss(calLoss);
    const ref = refMeta(calRefId);
    const triplet = adcTripletForSlot(calSensor);
    const adcCol = slotDataColumn(calSensor);
    const refPts = windowedTokenMap.get(ref.token) || [];

    const validPoints = calPoints.filter(
      (p) => p.ph.trim() !== "" && Number.isFinite(parseFloat(p.ph))
    );

    const lines: string[] = [];

    // Section 1: Configuration & regression summary
    lines.push("# Calibration Export");
    lines.push(`Sensor,${calSensor}`);
    lines.push(`Loss,${calLoss}`);
    lines.push(`Reference,${ref.label}`);
    lines.push("");
    lines.push("ISFET,R2,Sensitivity,Offset");
    for (const role of ROLES) {
      const r = regressionResults[role];
      lines.push(
        `${role},${r ? r.r2.toFixed(8) : ""},${r ? r.slope.toFixed(8) : ""},${r ? r.intercept.toFixed(8) : ""}`
      );
    }

    // Section 2: Calibration point averages
    lines.push("");
    lines.push("# Calibration Point Averages");
    lines.push("pH,Events,Avg_UL,Avg_UR,Avg_LL");
    for (const cp of validPoints) {
      const avgs: (string)[] = [];
      for (const role of ROLES) {
        const tokenKey =
          role === "UL" ? triplet.ul : role === "UR" ? triplet.ur : triplet.ll;
        const adcPts = windowedTokenMap.get(tokenKey) || [];
        const bfValues: number[] = [];
        for (const ec of cp.eventCounters) {
          const avgBf = avgDacForceForEvent(adcPts, loss, refPts, ref.col, ec, adcCol);
          if (avgBf !== null) bfValues.push(avgBf);
        }
        if (bfValues.length > 0) {
          const avg = bfValues.reduce((a, b) => a + b, 0) / bfValues.length;
          avgs.push(avg.toFixed(8));
        } else {
          avgs.push("");
        }
      }
      const evtStr = cp.eventCounters.join("+");
      lines.push(`${cp.ph},${evtStr},${avgs.join(",")}`);
    }

    // Section 3: Full time-series (ADC/loss - REF) for selected events
    const allEventCounters = new Set<number>();
    for (const cp of validPoints) {
      for (const ec of cp.eventCounters) allEventCounters.add(ec);
    }

    lines.push("");
    lines.push("# Time-Series Data (ADC/loss - REF) for Selected Events");
    lines.push("Elapsed (s),DateTime,Event,UL,UR,LL");

    const roleData: Record<string, Map<number, Map<number, number>>> = {};
    for (const role of ROLES) {
      const tokenKey =
        role === "UL" ? triplet.ul : role === "UR" ? triplet.ur : triplet.ll;
      const adcPts = windowedTokenMap.get(tokenKey) || [];
      const derived = deriveSingleEndedMinusRef(adcPts, loss, refPts, ref.col, adcCol);
      const filtered = derived.filter((p) => allEventCounters.has(p.eventCounter));
      const byLoop = new Map<number, { ts: number; elapsed: number; evt: number; val: number }>();
      for (const p of filtered) {
        byLoop.set(p.loopCounter, { ts: p.timestamp, elapsed: p.elapsedSeconds, evt: p.eventCounter, val: p.col6 });
      }
      roleData[role] = new Map();
      for (const [loop, d] of byLoop) {
        if (!roleData[role].has(loop)) roleData[role].set(loop, new Map());
        roleData[role].get(loop)!.set(d.ts, d.val);
      }
    }

    const ulDerived = deriveSingleEndedMinusRef(
      windowedTokenMap.get(triplet.ul) || [], loss, refPts, ref.col, adcCol
    ).filter((p) => allEventCounters.has(p.eventCounter));

    const allLoops = new Map<number, { ts: number; elapsed: number; evt: number }>();
    for (const p of ulDerived) {
      allLoops.set(p.loopCounter, { ts: p.timestamp, elapsed: p.elapsedSeconds, evt: p.eventCounter });
    }
    const urDerived = deriveSingleEndedMinusRef(
      windowedTokenMap.get(triplet.ur) || [], loss, refPts, ref.col, adcCol
    ).filter((p) => allEventCounters.has(p.eventCounter));
    for (const p of urDerived) {
      if (!allLoops.has(p.loopCounter)) allLoops.set(p.loopCounter, { ts: p.timestamp, elapsed: p.elapsedSeconds, evt: p.eventCounter });
    }
    const llDerived = deriveSingleEndedMinusRef(
      windowedTokenMap.get(triplet.ll) || [], loss, refPts, ref.col, adcCol
    ).filter((p) => allEventCounters.has(p.eventCounter));
    for (const p of llDerived) {
      if (!allLoops.has(p.loopCounter)) allLoops.set(p.loopCounter, { ts: p.timestamp, elapsed: p.elapsedSeconds, evt: p.eventCounter });
    }

    const ulByLoop = new Map<number, number>();
    for (const p of ulDerived) ulByLoop.set(p.loopCounter, p.col6);
    const urByLoop = new Map<number, number>();
    for (const p of urDerived) urByLoop.set(p.loopCounter, p.col6);
    const llByLoop = new Map<number, number>();
    for (const p of llDerived) llByLoop.set(p.loopCounter, p.col6);

    const sortedLoops = Array.from(allLoops.entries()).sort((a, b) => a[1].ts - b[1].ts);
    for (const [loop, info] of sortedLoops) {
      const ul = ulByLoop.get(loop);
      const ur = urByLoop.get(loop);
      const ll = llByLoop.get(loop);
      lines.push(
        `${info.elapsed.toFixed(3)},${new Date(info.ts).toISOString()},${info.evt},${ul !== undefined ? ul.toFixed(8) : ""},${ur !== undefined ? ur.toFixed(8) : ""},${ll !== undefined ? ll.toFixed(8) : ""}`
      );
    }

    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Calibration_${calSensor}_loss${calLoss}_${ref.label.replace(/\s+/g, "")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [calSensor, calLoss, calRefId, calPoints, windowedTokenMap, regressionResults]);

  const handleAddSensor = useCallback((slot?: string) => {
    const sensor = slot ?? addSensor;
    if (slot) setAddSensor(sensor);
    const num = nextCalibrationNumber(calibrationEntries, sensor);
    const label = makeCalibrationLabel(sensor, num);
    const entry: CalibrationEntry = {
      id: newEntryId(),
      sensor,
      calibrationNumber: num,
      label,
      values: {
        UL: { sensitivity: "0", offset: "0", r2: "" },
        UR: { sensitivity: "0", offset: "0", r2: "" },
        LL: { sensitivity: "0", offset: "0", r2: "" },
      },
    };
    onCalibrationEntriesChange([...calibrationEntries, entry]);
  }, [addSensor, calibrationEntries, onCalibrationEntriesChange]);

  const handleRemoveSensor = useCallback(
    (id: string) => {
      onCalibrationEntriesChange(calibrationEntries.filter((e) => e.id !== id));
    },
    [calibrationEntries, onCalibrationEntriesChange]
  );

  const handleEntryFieldChange = useCallback(
    (id: string, role: ISFETRole, field: "sensitivity" | "offset" | "r2", value: string) => {
      onCalibrationEntriesChange(
        calibrationEntries.map((e) =>
          e.id === id
            ? {
                ...e,
                values: {
                  ...e.values,
                  [role]: { ...e.values[role], [field]: value },
                },
              }
            : e
        )
      );
    },
    [calibrationEntries, onCalibrationEntriesChange]
  );

  const handleEntryLabelChange = useCallback(
    (id: string, label: string) => {
      onCalibrationEntriesChange(
        calibrationEntries.map((e) => (e.id === id ? { ...e, label } : e))
      );
    },
    [calibrationEntries, onCalibrationEntriesChange]
  );

  const importFileRef = useRef<HTMLInputElement | null>(null);

  const handleImportCalibration = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        const lines = text.split(/\r?\n/);

        let sensor = "";
        const roleValues: Record<string, { sensitivity: string; offset: string; r2: string }> = {};

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line || line.startsWith("#")) continue;

          const parts = line.split(",").map((s) => s.trim());
          if (parts[0] === "Sensor" && parts.length >= 2) {
            sensor = parts[1];
            continue;
          }
          if (parts[0] === "ISFET" && parts[1] === "R2") continue;
          if (["UL", "UR", "LL"].includes(parts[0]) && parts.length >= 4) {
            const fmt = (v: string) => {
              const n = parseFloat(v);
              return Number.isFinite(n) ? n.toFixed(6) : v;
            };
            roleValues[parts[0]] = {
              r2: parts[1] ? fmt(parts[1]) : "",
              sensitivity: parts[2] ? fmt(parts[2]) : "0",
              offset: parts[3] ? fmt(parts[3]) : "0",
            };
          }
        }

        if (!sensor) {
          alert("Could not find a Sensor field in the imported file.");
          return;
        }

        const defaultVal = { sensitivity: "0", offset: "0", r2: "" };
        const num = nextCalibrationNumber(calibrationEntries, sensor);
        const entry: CalibrationEntry = {
          id: newEntryId(),
          sensor,
          calibrationNumber: num,
          label: makeCalibrationLabel(sensor, num),
          values: {
            UL: roleValues["UL"] ?? defaultVal,
            UR: roleValues["UR"] ?? defaultVal,
            LL: roleValues["LL"] ?? defaultVal,
          },
        };
        onCalibrationEntriesChange([...calibrationEntries, entry]);
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [calibrationEntries, onCalibrationEntriesChange]
  );

  const handleExportTable = useCallback(() => {
    if (calibrationEntries.length === 0) return;
    const lines: string[] = [];
    lines.push("Sensor,Identifier,ISFET,R2,Sensitivity (V),Offset (V)");
    for (const entry of calibrationEntries) {
      for (const role of ROLES) {
        const v = entry.values[role];
        lines.push(
          `${entry.sensor},${entry.label},${role},${v.r2},${v.sensitivity},${v.offset}`
        );
      }
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Calibration_Table.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [calibrationEntries]);

  const [phVisibleRoles, setPhVisibleRoles] = useState<ISFETRole[]>([...ROLES]);
  const togglePhVisibleRole = useCallback((role: ISFETRole) => {
    setPhVisibleRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  }, []);

  const dragEntryId = useRef<string | null>(null);

  const handleDragStart = useCallback((entryId: string) => {
    dragEntryId.current = entryId;
  }, []);

  const handleDrop = useCallback(
    (targetId: string) => {
      const srcId = dragEntryId.current;
      dragEntryId.current = null;
      if (!srcId || srcId === targetId) return;
      const arr = [...calibrationEntries];
      const srcIdx = arr.findIndex((e) => e.id === srcId);
      const tgtIdx = arr.findIndex((e) => e.id === targetId);
      if (srcIdx < 0 || tgtIdx < 0) return;
      const [moved] = arr.splice(srcIdx, 1);
      arr.splice(tgtIdx, 0, moved);
      onCalibrationEntriesChange(arr);
    },
    [calibrationEntries, onCalibrationEntriesChange]
  );

  const groupedEntries = useMemo(() => {
    const groups: { sensor: string; entries: CalibrationEntry[] }[] = [];
    const seen = new Map<string, CalibrationEntry[]>();
    for (const e of calibrationEntries) {
      if (!seen.has(e.sensor)) {
        const list: CalibrationEntry[] = [];
        seen.set(e.sensor, list);
        groups.push({ sensor: e.sensor, entries: list });
      }
      seen.get(e.sensor)!.push(e);
    }
    return groups;
  }, [calibrationEntries]);

  return (
    <div className="cal-page">
      <div className="cal-tool">
        <h3 className="cal-section-title">Calibration</h3>

        <div className="cal-tool-controls">
          <div className="cal-tool-row" style={{ marginBottom: 4 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={useDenoised}
                onChange={(e) => setUseDenoised(e.target.checked)}
              />
              Use Denoised Data
              <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 400 }}>
                (MAD spike removal before calibration averages)
              </span>
            </label>
          </div>
          <div className="cal-tool-row">
            <div className="cal-field">
              <span className="cal-field-label">Sensor</span>
              <SlotPicker value={calSensor} onChange={setCalSensor} />
            </div>
            <label className="cal-field">
              <span className="cal-field-label">Loss</span>
              <input
                type="text"
                className="cal-input"
                value={calLoss}
                onChange={(e) => {
                  patch({ calLoss: e.target.value, hasCalibrated: false });
                }}
                placeholder="0.9"
              />
            </label>
            <label className="cal-field">
              <span className="cal-field-label">Reference</span>
              <select
                className="cal-select"
                value={calRefId}
                onChange={(e) => {
                  patch({ calRefId: e.target.value as RefCheckId, hasCalibrated: false });
                }}
              >
                {REF_CHECKBOXES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="cal-points">
            <div className="cal-points-header">
              <span />
              <span>Event</span>
              <span>pH</span>
              <span />
            </div>
            {calPoints.map((pt, i) => (
              <div key={pt.id} className="cal-point-row cal-point-multi">
                <span className="cal-point-label">Point {i + 1}</span>
                <div className="cal-event-list">
                  {pt.eventCounters.map((ec, ei) => (
                    <div key={ei} className="cal-event-item">
                      <select
                        className="cal-select"
                        value={ec}
                        onChange={(e) => {
                          const updated = [...pt.eventCounters];
                          updated[ei] = Number(e.target.value);
                          updatePoint(pt.id, { eventCounters: updated });
                        }}
                      >
                        {events.map((ev) => (
                          <option key={ev} value={ev}>
                            {eventCaptions.get(ev) ?? ev}
                          </option>
                        ))}
                      </select>
                      {pt.eventCounters.length > 1 && (
                        <button
                          type="button"
                          className="cal-remove-event-btn"
                          onClick={() => {
                            const updated = pt.eventCounters.filter((_, j) => j !== ei);
                            updatePoint(pt.id, { eventCounters: updated });
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="cal-add-event-btn"
                    onClick={() => {
                      updatePoint(pt.id, {
                        eventCounters: [...pt.eventCounters, events[0] ?? 1],
                      });
                    }}
                  >
                    + Event
                  </button>
                </div>
                <input
                  type="text"
                  className="cal-input"
                  value={pt.ph}
                  onChange={(e) => updatePoint(pt.id, { ph: e.target.value })}
                  placeholder="7.0"
                />
                <button
                  type="button"
                  className="cal-remove-btn"
                  disabled={calPoints.length <= 1}
                  onClick={() => removePoint(pt.id)}
                >
                  Remove Point
                </button>
              </div>
            ))}
            <button type="button" className="cal-add-btn" onClick={addPoint}>
              + Add point
            </button>
          </div>

          <div className="cal-actions">
            <button type="button" className="cal-calibrate-btn" onClick={handleCalibrate}>
              Calibrate
            </button>
            {hasCalibrated && (
              <>
                <button type="button" className="cal-save-btn" onClick={handleSaveCalibration}>
                  Save to table
                </button>
                <button type="button" className="cal-export-btn" onClick={handleExportCalibration}>
                  Export Calibration
                </button>
              </>
            )}
            <button
              type="button"
              className="cal-new-btn"
              onClick={() => {
                onFormStateChange({
                  ...formState,
                  calPoints: [
                    { id: newPointId(), eventCounters: [events[0] ?? 1], ph: "7" },
                    { id: newPointId(), eventCounters: [events[1] ?? 2], ph: "7" },
                  ],
                  regressionResults: { UL: null, UR: null, LL: null },
                  hasCalibrated: false,
                });
              }}
            >
              New Calibration
            </button>
          </div>
        </div>

        {hasCalibrated && (
          <div className="cal-results">
            <div className="cal-results-layout">
              <div className="cal-results-chart-panel">
                {/* ISFET visibility checkboxes for pH chart */}
                <div style={{ display: "flex", gap: 10, padding: "4px 0 6px", fontSize: 12 }}>
                  {ROLES.map((role) => (
                    <label key={role} style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={phVisibleRoles.includes(role)}
                        onChange={() => togglePhVisibleRole(role)}
                      />
                      {role}
                    </label>
                  ))}
                </div>
                <CombinedRegressionChart results={regressionResults} visibleRoles={phVisibleRoles} />
              </div>
              <div className="cal-results-summary">
                <h4>R² &amp; Calibration Values</h4>
                <table className="cal-r2-table">
                  <thead>
                    <tr>
                      <th>ISFET</th>
                      <th>R²</th>
                      <th>Sensitivity</th>
                      <th>Offset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROLES.map((role) => {
                      const r = regressionResults[role];
                      return (
                        <tr key={role}>
                          <td className="cal-r2-role">{role}</td>
                          <td>{r ? r.r2.toFixed(6) : "—"}</td>
                          <td>{r ? r.slope.toFixed(6) : "—"}</td>
                          <td>{r ? r.intercept.toFixed(6) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="cal-table-section">
        <div className="cal-table-header">
          <h3 className="cal-section-title">Sensor Calibration Table</h3>
          <div className="cal-table-header-actions">
            {calibrationEntries.length > 0 && (
              <button type="button" className="cal-export-table-btn" onClick={handleExportTable}>
                Export Table
              </button>
            )}
            <button
              type="button"
              className="cal-import-btn"
              onClick={() => importFileRef.current?.click()}
            >
              Import Calibration
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept=".csv,.txt"
              style={{ display: "none" }}
              onChange={handleImportCalibration}
            />
          </div>
        </div>
        <div className="cal-table-wrap">
          <table className="cal-table">
            <thead>
              <tr>
                <th />
                <th>Sensor</th>
                <th>Identifier</th>
                <th>ISFET</th>
                <th>R²</th>
                <th>Sensitivity (V)</th>
                <th>Offset (V)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groupedEntries.map((group) =>
                group.entries.map((entry) =>
                  ROLES.map((role, ri) => (
                    <tr
                      key={`${entry.id}-${role}`}
                      className={ri === 0 ? "cal-row-first" : ""}
                      onDragOver={(e) => { if (ri === 0) e.preventDefault(); }}
                      onDrop={() => { if (ri === 0) handleDrop(entry.id); }}
                    >
                      {ri === 0 && (
                        <>
                          <td
                            rowSpan={3}
                            className="cal-cell-drag"
                            draggable
                            onDragStart={() => handleDragStart(entry.id)}
                          >
                            ⠿
                          </td>
                          <td rowSpan={3} className="cal-cell-sensor">
                            {entry.sensor}
                          </td>
                          <td rowSpan={3} className="cal-cell-num">
                            <input
                              type="text"
                              className="cal-table-input"
                              value={entry.label}
                              onChange={(e) =>
                                handleEntryLabelChange(entry.id, e.target.value)
                              }
                            />
                          </td>
                        </>
                      )}
                      <td className="cal-cell-isfet">{role}</td>
                      <td>
                        <input
                          type="text"
                          className="cal-table-input"
                          value={entry.values[role].r2 ?? ""}
                          onChange={(e) =>
                            handleEntryFieldChange(entry.id, role, "r2", e.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="cal-table-input"
                          value={entry.values[role].sensitivity}
                          onChange={(e) =>
                            handleEntryFieldChange(entry.id, role, "sensitivity", e.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="cal-table-input"
                          value={entry.values[role].offset}
                          onChange={(e) =>
                            handleEntryFieldChange(entry.id, role, "offset", e.target.value)
                          }
                        />
                      </td>
                      {ri === 0 && (
                        <td rowSpan={3} className="cal-cell-actions">
                          <button
                            type="button"
                            className="cal-remove-btn"
                            onClick={() => handleRemoveSensor(entry.id)}
                          >
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )
              )}
            </tbody>
          </table>
        </div>
        <div className="cal-table-footer">
          <SlotPicker value={addSensor} onChange={(slot) => handleAddSensor(slot)} />
        </div>
      </div>

      {calibrationEntries.length > 0 && (
        <div className="cal-comparison-section">
          <h3 className="cal-section-title">Calibration Comparison</h3>
          <div className="cal-comparison-grid">
            <CalibrationComparisonChart
              entries={calibrationEntries}
              field="sensitivity"
              title="Sensitivity Comparison"
              yLabel="Sensitivity (V)"
            />
            <CalibrationComparisonChart
              entries={calibrationEntries}
              field="offset"
              title="Offset Comparison"
              yLabel="Offset (V)"
            />
            <CalibrationComparisonChart
              entries={calibrationEntries}
              field="r2"
              title="R² Comparison"
              yLabel="R²"
            />
          </div>
        </div>
      )}

      <CombPHCalibrationSection
        windowedTokenMap={windowedTokenMap}
        events={events}
        eventCaptions={eventCaptions}
        combPHEntries={combPHEntries}
        onCombPHEntriesChange={onCombPHEntriesChange}
        dnParams={effectiveDnParams}
      />

      <TargetCalibrationSection
        windowedTokenMap={windowedTokenMap}
        events={events}
        eventCaptions={eventCaptions}
        targetCalEntries={targetCalEntries}
        onTargetCalEntriesChange={onTargetCalEntriesChange}
        tcSensors={tcSensors}
        onTcSensorsChange={onTcSensorsChange}
        tcLoss={tcLoss}
        onTcLossChange={onTcLossChange}
        tcRefId={tcRefId}
        onTcRefIdChange={onTcRefIdChange}
        tcPoints={tcPoints}
        onTcPointsChange={onTcPointsChange}
        dnParams={effectiveDnParams}
      />
    </div>
  );
}
