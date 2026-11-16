/** Shared event palette: 31 unique entries, including bright accents. */
export const EVENT_COLOR_PALETTE = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#facc15",
  "#9333ea",
  "#ff1493",
  "#06b6d4",
  "#f97316",
  "#312e81",
  "#0d9488",
  "#92400e",
  "#be123c",
  "#c084fc",
  "#39e600",
  "#c026d3",
  "#0369a1",
  "#7f1d1d",
  "#a3e635",
  "#701a75",
  "#164e63",
  "#fbbf24",
  "#818cf8",
  "#047857",
  "#fb7185",
  "#6d28d9",
  "#2dd4bf",
  "#d97706",
  "#38bdf8",
  "#14532d",
  "#f472b6",
  "#78716c",
] as const;

// Reserve a color per event name so hash collisions cannot reuse a swatch.
// The same name keeps its color across charts and live updates in this session.
const assignedColors = new Map<string, string>();
const usedColors = new Set<string>();

export function colorForEventName(name: string): string {
  const key = name.trim();
  if (!key) return "#64748b";
  const existing = assignedColors.get(key);
  if (existing) return existing;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const start = (hash >>> 0) % EVENT_COLOR_PALETTE.length;
  let color: string | undefined;
  for (let offset = 0; offset < EVENT_COLOR_PALETTE.length; offset++) {
    const candidate = EVENT_COLOR_PALETTE[(start + offset) % EVENT_COLOR_PALETTE.length];
    if (!usedColors.has(candidate)) {
      color = candidate;
      break;
    }
  }
  // Extra names receive unique generated colors instead of cycling the palette.
  if (!color) {
    const index = assignedColors.size - EVENT_COLOR_PALETTE.length;
    color = `hsl(${(index * 137.508) % 360}, 80%, 45%)`;
  }
  assignedColors.set(key, color);
  usedColors.add(color);
  return color;
}
