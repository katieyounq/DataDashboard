import { useMemo, useRef, useEffect } from "react";
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
import { computeYRange, getEventSegments, getTokenLabel } from "../utils/dataHelpers";
import { elapsedMs, formatElapsed } from "../utils/dataTimeBounds";

ChartJS.register(LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler);

const EMPTY_EVENT_LABELS = new Map<number, string>();

interface ProbeChartProps {
  token: string;
  points: DataRow[];
  column: keyof DataRow;
  height?: number;
  /** Per event counter, caption from the data file / stream (optional). */
  eventLabels?: Map<number, string>;
}

export default function ProbeChart({
  token,
  points,
  column,
  height = 200,
  eventLabels,
}: ProbeChartProps) {
  const chartRef = useRef<ChartJS<"line"> | null>(null);
  const yRange = useMemo(() => computeYRange(points, column), [points, column]);
  const segments = useMemo(() => getEventSegments(points), [points]);

  useEffect(() => {
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, []);

  const chartData: ChartData<"line"> = useMemo(() => {
    const labelMap = eventLabels ?? EMPTY_EVENT_LABELS;
    const datasets = segments.map((seg) => {
      const segPoints = points.slice(seg.startIndex, seg.endIndex + 1);
      return {
        label: resolveEventCaption(seg.eventCounter, labelMap),
        data: segPoints.map((p) => ({
          x: elapsedMs(p),
          y: p[column] as number,
        })),
        borderColor: getEventColor(seg.eventCounter),
        backgroundColor: getEventColor(seg.eventCounter),
        borderWidth: 1.2,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0,
        fill: false,
      };
    });

    return { datasets };
  }, [points, segments, column, eventLabels]);

  const options: ChartOptions<"line"> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false as const,
      plugins: {
        title: {
          display: true,
          text: getTokenLabel(token),
          font: { size: 12, weight: "bold" as const },
          padding: { top: 4, bottom: 4 },
          color: "#1a1a2e",
        },
        legend: { display: false },
        tooltip: {
          mode: "nearest" as const,
          intersect: false,
          callbacks: {
            title: (items) => {
              if (!items.length) return "";
              return formatElapsed(items[0].parsed.x as number, true);
            },
            label: (item) => `${(item.parsed.y ?? 0).toFixed(6)} V`,
          },
        },
      },
      scales: {
        x: {
          type: "linear" as const,
          ticks: {
            maxTicksLimit: 8,
            font: { size: 9 },
            color: "#666",
            callback: (value) => formatElapsed(value as number),
          },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
        y: {
          min: yRange.min,
          max: yRange.max,
          ticks: { maxTicksLimit: 10, font: { size: 9 }, color: "#666" },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
      },
      interaction: {
        mode: "nearest" as const,
        axis: "x" as const,
        intersect: false,
      },
    }),
    [token, yRange]
  );

  return (
    <div className="probe-chart" style={{ height }}>
      <Line ref={chartRef} data={chartData} options={options} />
    </div>
  );
}
