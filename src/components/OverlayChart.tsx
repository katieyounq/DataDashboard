import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
  type ChartData,
} from "chart.js";
import { Line } from "react-chartjs-2";
import "chartjs-adapter-date-fns";
import type { DataRow } from "../utils/csvParser";
import { getEventColor, resolveEventCaption } from "../utils/csvParser";
import { elapsedMs, formatElapsed } from "../utils/dataTimeBounds";
import { denoiseDataRows, type DenoiseParams, DEFAULT_DENOISE_PARAMS } from "../utils/denoise";

export type EventVisualResolver = (p: DataRow) => { caption: string; color: string };

ChartJS.register(LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler);

export interface OverlaySeries {
  key: string;
  label: string;
  points: DataRow[];
  color: string;
  /** When set, this series reads Y from this field (needed for REF A/B multi-column). */
  column?: keyof DataRow;
  /** Chart.js line dash; used to separate UL/UR/LL when color encodes event. */
  borderDash?: number[];
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-. ]/g, "_").replace(/_+/g, "_").trim();
}

function buildChartCsv(
  series: OverlaySeries[],
  defaultColumn: keyof DataRow
): string {
  const visible = series.filter((s) => s.points.length > 0);
  if (visible.length === 0) return "";

  if (visible.length === 1) {
    const s = visible[0];
    const col = s.column ?? defaultColumn;
    const rows = ["Elapsed (s),DateTime," + s.label];
    for (const p of s.points) {
      rows.push(
        `${p.elapsedSeconds.toFixed(3)},${new Date(p.timestamp).toISOString()},${(p[col] as number).toFixed(8)}`
      );
    }
    return rows.join("\n");
  }

  const allTs = new Map<number, { elapsed: number; abs: number; vals: (number | null)[] }>();
  for (let si = 0; si < visible.length; si++) {
    const col = visible[si].column ?? defaultColumn;
    for (const p of visible[si].points) {
      const key = elapsedMs(p);
      if (!allTs.has(key)) {
        allTs.set(key, { elapsed: p.elapsedSeconds, abs: p.timestamp, vals: new Array(visible.length).fill(null) });
      }
      allTs.get(key)!.vals[si] = p[col] as number;
    }
  }

  const sorted = Array.from(allTs.entries()).sort((a, b) => a[0] - b[0]);
  const header = ["Elapsed (s)", "DateTime", ...visible.map((s) => s.label)];
  const rows = [header.join(",")];
  for (const [, entry] of sorted) {
    rows.push(
      `${entry.elapsed.toFixed(3)},${new Date(entry.abs).toISOString()},${entry.vals.map((v) => (v !== null ? v.toFixed(8) : "")).join(",")}`
    );
  }
  return rows.join("\n");
}

function downloadCsv(csvContent: string, filename: string) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface OverlayChartProps {
  title: string;
  series: OverlaySeries[];
  column: keyof DataRow;
  height?: number;
  showLegend?: boolean;
  /** Cap legend height so many traces scroll instead of stretching the page. */
  legendMaxHeight?: number;
  yUnit?: string;
  /** Line segments colored by `eventCounter`; ADC role from label/dash. */
  colorByEvent?: boolean;
  eventLabels?: Map<number, string>;
  /** When set with `colorByEvent`, drives segment color and tooltip caption (e.g. DataConfig names by time). */
  resolveEventVisual?: EventVisualResolver;
  /** Optional page-level prefix for the exported CSV filename. */
  pageTitle?: string;
  /** When provided, enables drag-to-select; callback receives (startElapsedMs, endElapsedMs). */
  onRangeSelect?: (startMs: number, endMs: number) => void;
  /** When true, show denoised data by default (global toggle). */
  globalDenoise?: boolean;
  /** Denoise parameters for the MAD algorithm. */
  denoiseParams?: DenoiseParams;
}

function seriesColumn(s: OverlaySeries, fallback: keyof DataRow): keyof DataRow {
  return s.column ?? fallback;
}

function yRangeForSeries(series: OverlaySeries[], defaultColumn: keyof DataRow) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    const col = seriesColumn(s, defaultColumn);
    for (const p of s.points) {
      const v = p[col] as number;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  const pad = (max - min) * 0.05 || 0.01;
  return { min: min - pad, max: max + pad };
}

/** Detect event boundaries from data points and return midpoint + label for each event span. */
function detectEventAnnotations(
  series: OverlaySeries[],
  resolveVisual?: EventVisualResolver,
  labelMap?: Map<number, string>
): { midMs: number; label: string; color: string; startMs: number; endMs: number }[] {
  // Gather all (elapsedMs, eventCounter, point) from the first series with data
  const src = series.find((s) => s.points.length > 0);
  if (!src) return [];
  const pts = src.points;
  if (pts.length === 0) return [];

  // Build spans of contiguous event regions
  const spans: { ec: number; startMs: number; endMs: number; sample: DataRow }[] = [];
  let curEc = pts[0].eventCounter;
  let spanStart = elapsedMs(pts[0]);
  let sample = pts[0];

  for (let i = 1; i < pts.length; i++) {
    const ms = elapsedMs(pts[i]);
    if (pts[i].eventCounter !== curEc) {
      spans.push({ ec: curEc, startMs: spanStart, endMs: elapsedMs(pts[i - 1]), sample });
      curEc = pts[i].eventCounter;
      spanStart = ms;
      sample = pts[i];
    }
  }
  spans.push({ ec: curEc, startMs: spanStart, endMs: elapsedMs(pts[pts.length - 1]), sample });

  return spans.map((s) => {
    let label: string;
    let color: string;
    if (resolveVisual) {
      const vis = resolveVisual(s.sample);
      // Only graph annotations omit the counter; legends/tooltips retain it.
      const prefix = `${s.ec} – `;
      label = vis.caption.startsWith(prefix) ? vis.caption.slice(prefix.length) : vis.caption;
      color = vis.color;
    } else {
      const fromMap = labelMap?.get(s.ec)?.trim();
      label = fromMap || `Event ${s.ec}`;
      color = getEventColor(s.ec);
    }
    return {
      midMs: (s.startMs + s.endMs) / 2,
      label,
      color,
      startMs: s.startMs,
      endMs: s.endMs,
    };
  });
}

/** Chart.js plugin that draws event name labels at the top of the chart area. */
const eventAnnotationPlugin = {
  id: "eventAnnotations",
  afterDraw(chart: ChartJS) {
    const annotations = (chart as any).__eventAnnotations as
      | ReturnType<typeof detectEventAnnotations>
      | undefined;
    if (!annotations || annotations.length === 0) return;

    const ctx = chart.ctx;
    const area = chart.chartArea;
    const scale = chart.scales.x;
    if (!scale) return;

    ctx.save();
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const rowEnds = [area.left - 6, area.left - 6, area.left - 6];
    let preferredRow = 0;
    for (const ann of annotations) {
      const px = scale.getPixelForValue(ann.midMs);
      if (px < area.left || px > area.right) continue;

      // Alternate rows, measuring actual text so nearby names do not collide.
      const width = Math.min(ctx.measureText(ann.label).width, area.right - area.left);
      const left = Math.max(area.left, Math.min(px - width / 2, area.right - width));
      const candidates = [preferredRow, 1 - preferredRow, 2];
      let row = candidates.find((r) => rowEnds[r] + 6 <= left);
      if (row === undefined) {
        row = rowEnds.indexOf(Math.min(...rowEnds));
      }
      const labelLeft = Math.max(left, rowEnds[row] + 6);
      const available = area.right - labelLeft;
      let text = ann.label;
      if (ctx.measureText(text).width > available) {
        while (text.length && ctx.measureText(`${text}…`).width > available) {
          text = text.slice(0, -1);
        }
        text = text ? `${text}…` : "";
      }
      if (text) {
        ctx.fillStyle = ann.color;
        ctx.textAlign = "left";
        ctx.fillText(text, labelLeft, area.top - 42 + row * 13);
        rowEnds[row] = labelLeft + ctx.measureText(text).width;
        preferredRow = row === 0 ? 1 : 0;
      }

      // Draw subtle vertical line at event start
      const startPx = scale.getPixelForValue(ann.startMs);
      if (startPx >= area.left && startPx <= area.right) {
        ctx.strokeStyle = ann.color;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(startPx, area.top);
        ctx.lineTo(startPx, area.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  },
};

ChartJS.register(eventAnnotationPlugin);

export default function OverlayChart({
  title,
  series,
  column,
  height = 200,
  showLegend = true,
  legendMaxHeight,
  yUnit = "V",
  colorByEvent = false,
  eventLabels,
  resolveEventVisual,
  pageTitle,
  onRangeSelect,
  globalDenoise = false,
  denoiseParams,
}: OverlayChartProps) {
  const chartRef = useRef<ChartJS<"line"> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const isDragging = useRef(false);
  const [localDenoise, setLocalDenoise] = useState(false);

  const denoiseActive = globalDenoise || localDenoise;

  const effectiveSeries = useMemo(() => {
    if (!denoiseActive) return series;
    const params = denoiseParams ?? DEFAULT_DENOISE_PARAMS;
    return series.map((s) => {
      if (s.points.length === 0) return s;
      const col = s.column ?? column;
      return { ...s, points: denoiseDataRows(s.points, col, params) };
    });
  }, [series, denoiseActive, denoiseParams, column]);

  const yRange = useMemo(() => yRangeForSeries(effectiveSeries, column), [effectiveSeries, column]);

  const eventAnnotations = useMemo(() => {
    if (!colorByEvent) return [];
    return detectEventAnnotations(effectiveSeries, resolveEventVisual, eventLabels);
  }, [colorByEvent, effectiveSeries, resolveEventVisual, eventLabels]);
  const visibleSeries = useMemo(
    () => effectiveSeries.filter((s) => s.points.length > 0),
    [effectiveSeries]
  );
  const visibleSeriesCount = visibleSeries.length;
  const denseLegend = visibleSeriesCount > 6;

  useEffect(() => {
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, []);

  // Keep event annotations in sync on re-renders
  useEffect(() => {
    if (chartRef.current) {
      (chartRef.current as any).__eventAnnotations = eventAnnotations;
      chartRef.current.draw();
    }
  }, [eventAnnotations]);

  const chartData: ChartData<"line"> = useMemo(() => {
    const datasets = visibleSeries.map((s) => {
        const col = seriesColumn(s, column);
        const pts = s.points;
        const dash = s.borderDash ?? [];
        const neutral = "#94a3b8";
        const baseColor = colorByEvent ? neutral : s.color;
        return {
          label: s.label,
          data: pts.map((p) => ({
            x: elapsedMs(p),
            y: p[col] as number,
          })),
          borderColor: baseColor,
          backgroundColor: baseColor,
          borderWidth: 1.4,
          borderDash: dash,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0,
          fill: false,
          segment: colorByEvent
            ? {
                borderColor: (ctx: { p1DataIndex: number }) => {
                  const i = ctx.p1DataIndex;
                  const p = pts[i];
                  if (!p) return neutral;
                  if (resolveEventVisual) return resolveEventVisual(p).color;
                  return getEventColor(p.eventCounter);
                },
              }
            : undefined,
        };
      });
    return { datasets };
  }, [visibleSeries, column, colorByEvent, resolveEventVisual]);

  const options: ChartOptions<"line"> = useMemo(
    () => {
      const labelMap = eventLabels ?? new Map<number, string>();
      return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false as const,
      plugins: {
        title: {
          display: true,
          text: denoiseActive ? `${title} (Denoised)` : title,
          font: { size: 11, weight: "bold" as const },
          padding: { top: 2, bottom: colorByEvent ? 46 : 4 },
          color: "#1a1a2e",
        },
        legend: {
          display: showLegend && visibleSeriesCount > 1,
          position: "bottom" as const,
          maxHeight: legendMaxHeight,
          labels: {
            boxWidth: denseLegend ? 8 : 10,
            padding: denseLegend ? 3 : 6,
            font: { size: denseLegend ? 8 : 9 },
          },
        },
        tooltip: {
          mode: "nearest" as const,
          intersect: false,
          callbacks: {
            title: (items) => {
              if (!items.length) return "";
              return formatElapsed(items[0].parsed.x as number, true);
            },
            label: (item) => {
              const dsIndex = item.datasetIndex ?? 0;
              const s = visibleSeries[dsIndex];
              const idx = item.dataIndex;
              let ev = "";
              if (colorByEvent && s?.points && idx != null) {
                const p = s.points[idx];
                if (p) {
                  const cap = resolveEventVisual
                    ? resolveEventVisual(p).caption
                    : resolveEventCaption(p.eventCounter, labelMap);
                  ev = ` · ${cap}`;
                }
              }
              return `${item.dataset.label ?? ""}: ${(item.parsed.y ?? 0).toFixed(6)} ${yUnit}${ev}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear" as const,
          ticks: {
            maxTicksLimit: 8,
            font: { size: 8 },
            color: "#666",
            callback: (value) => formatElapsed(value as number),
          },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
        y: {
          min: yRange.min,
          max: yRange.max,
          ticks: { maxTicksLimit: 10, font: { size: 8 }, color: "#666" },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
      },
      interaction: { mode: "nearest" as const, axis: "x" as const, intersect: false },
    };
  },
  [
      title,
      yRange,
      visibleSeries,
      showLegend,
      yUnit,
      visibleSeriesCount,
      denseLegend,
      legendMaxHeight,
      colorByEvent,
      eventLabels,
      resolveEventVisual,
      denoiseActive,
    ]
  );

  const hasData = series.some((s) => s.points.length > 0);

  const handleExport = useCallback(() => {
    const csv = buildChartCsv(series, column);
    if (!csv) return;
    const prefix = pageTitle ? sanitizeFilename(pageTitle) + "_" : "";
    const fname = prefix + sanitizeFilename(title) + ".csv";
    downloadCsv(csv, fname);
  }, [series, column, title, pageTitle]);

  const pxToElapsedMs = useCallback((clientX: number): number | null => {
    const chart = chartRef.current;
    if (!chart) return null;
    const rect = chart.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const scale = chart.scales.x;
    if (!scale) return null;
    return scale.getValueForPixel(x) ?? null;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!onRangeSelect) return;
    const ms = pxToElapsedMs(e.clientX);
    if (ms === null) return;
    isDragging.current = true;
    setDragStart(ms);
    setDragEnd(ms);
  }, [onRangeSelect, pxToElapsedMs]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const ms = pxToElapsedMs(e.clientX);
    if (ms !== null) setDragEnd(ms);
  }, [pxToElapsedMs]);

  const handleMouseUp = useCallback(() => {
    if (!isDragging.current || dragStart === null || dragEnd === null) {
      isDragging.current = false;
      setDragStart(null);
      setDragEnd(null);
      return;
    }
    isDragging.current = false;
    const lo = Math.min(dragStart, dragEnd);
    const hi = Math.max(dragStart, dragEnd);
    setDragStart(null);
    setDragEnd(null);
    if (hi - lo > 100 && onRangeSelect) {
      onRangeSelect(lo, hi);
    }
  }, [dragStart, dragEnd, onRangeSelect]);

  const dragOverlayStyle = useMemo<React.CSSProperties | null>(() => {
    if (dragStart === null || dragEnd === null) return null;
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return null;
    const scale = chart.scales.x;
    if (!scale) return null;

    // Account for the offset between the canvas and the container div.
    // scale.getPixelForValue() returns pixels relative to the canvas,
    // but the overlay is positioned relative to the container.
    const canvasRect = chart.canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const offsetX = canvasRect.left - containerRect.left;
    const offsetY = canvasRect.top - containerRect.top;

    const lo = Math.min(dragStart, dragEnd);
    const hi = Math.max(dragStart, dragEnd);
    const leftPx = scale.getPixelForValue(lo) + offsetX;
    const rightPx = scale.getPixelForValue(hi) + offsetX;
    const area = chart.chartArea;
    return {
      position: "absolute" as const,
      left: leftPx,
      top: area.top + offsetY,
      width: Math.max(rightPx - leftPx, 1),
      height: area.bottom - area.top,
      backgroundColor: "rgba(37, 99, 235, 0.15)",
      border: "1px solid rgba(37, 99, 235, 0.4)",
      pointerEvents: "none" as const,
      zIndex: 5,
    };
  }, [dragStart, dragEnd]);

  return (
    <div
      ref={containerRef}
      className={`probe-chart overlay-chart${onRangeSelect ? " chart-selectable" : ""}`}
      style={{ height, width: "100%", maxWidth: "100%", position: "relative" }}
      onMouseDown={onRangeSelect ? handleMouseDown : undefined}
      onMouseMove={onRangeSelect ? handleMouseMove : undefined}
      onMouseUp={onRangeSelect ? handleMouseUp : undefined}
      onMouseLeave={onRangeSelect ? handleMouseUp : undefined}
    >
      {hasData && (
        <>
          <button
            type="button"
            className={`chart-denoise-btn${denoiseActive ? " chart-denoise-btn--active" : ""}`}
            onClick={() => setLocalDenoise((v) => !v)}
            title={denoiseActive ? "Showing denoised data (click to show raw)" : "Show denoised data (MAD spike removal)"}
          >
            {denoiseActive ? "DN" : "DN"}
          </button>
          <button
            type="button"
            className="chart-export-btn"
            onClick={handleExport}
            title="Export chart data as CSV"
          >
            ⬇
          </button>
        </>
      )}
      {hasData ? (
        <Line
          ref={(ref) => {
            chartRef.current = ref ?? null;
            if (ref) (ref as any).__eventAnnotations = eventAnnotations;
          }}
          data={chartData}
          options={options}
        />
      ) : (
        <div className="chart-placeholder">No data</div>
      )}
      {dragOverlayStyle && <div style={dragOverlayStyle} />}
    </div>
  );
}
