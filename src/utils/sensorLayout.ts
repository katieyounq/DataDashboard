import type { DataRow } from "./csvParser";

/** Row letters A–D match ADC triplets 01–03, 04–06, …, 10–12. */
export const ROW_LETTERS = ["A", "B", "C", "D"] as const;
export type RowLetter = (typeof ROW_LETTERS)[number];

/** Slot IDs: column 1–6 + row letter (e.g. 1A, 6D). Column + row pick which ADC01–12 triplet is shown. */
export function allSensorSlotIds(): string[] {
  const ids: string[] = [];
  for (const r of ROW_LETTERS) {
    for (let c = 1; c <= 6; c++) {
      ids.push(`${c}${r}`);
    }
  }
  return ids;
}

export function slotRowLetter(slot: string): RowLetter {
  const ch = slot.slice(-1).toUpperCase();
  if (ROW_LETTERS.includes(ch as RowLetter)) return ch as RowLetter;
  return "A";
}

export function slotColumn(slot: string): number {
  const n = parseInt(slot.slice(0, -1), 10);
  return Number.isFinite(n) && n >= 1 && n <= 6 ? n : 1;
}

export function rowLetterToIndex(letter: RowLetter): number {
  return ROW_LETTERS.indexOf(letter);
}

function adcToken(n: number): string {
  return `ADC${String(n).padStart(2, "0")} (V)`;
}

function diffToken(n: number): string {
  return `DIFF${String(n).padStart(2, "0")} (V)`;
}

/** UR, UL, LL ADC tokens for a row (A→01–03, B→04–06, …) — column ignored. */
export function adcTripletForRow(rowIndex: number): { ur: string; ul: string; ll: string } {
  const base = 1 + rowIndex * 3;
  return { ur: adcToken(base), ul: adcToken(base + 1), ll: adcToken(base + 2) };
}

/** DIFF01–03 for row A, DIFF04–06 for row B, … */
export function diffTripletForRow(rowIndex: number): { urUl: string; ulLl: string; urLl: string } {
  const base = 1 + rowIndex * 3;
  return {
    urUl: diffToken(base),
    ulLl: diffToken(base + 1),
    urLl: diffToken(base + 2),
  };
}

/**
 * First ADC index (1–12) for this slot’s UR channel; UL = base+1, LL = base+2.
 * Only the row letter determines the ADC triplet:
 *   A → ADC01-03, B → ADC04-06, C → ADC07-09, D → ADC10-12.
 * The column number (1–6) determines which data column (col1–col6) to read
 * — use `slotDataColumn(slot)` for that.
 */
export function adcBaseIndexForSlot(slot: string): number {
  const rowIdx = rowLetterToIndex(slotRowLetter(slot));
  return 1 + rowIdx * 3;
}

/** The data column (col1–col6) for a slot, determined by the column number. */
export function slotDataColumn(slot: string): keyof DataRow {
  return `col${slotColumn(slot)}` as keyof DataRow;
}

export function adcTripletForSlot(slot: string) {
  const base = adcBaseIndexForSlot(slot);
  return { ur: adcToken(base), ul: adcToken(base + 1), ll: adcToken(base + 2) };
}

export function diffTripletForSlot(slot: string) {
  const base = adcBaseIndexForSlot(slot);
  return {
    urUl: diffToken(base),
    ulLl: diffToken(base + 1),
    urLl: diffToken(base + 2),
  };
}

/** Sort slots by column then row (1A, 2A, …, 1B, …). */
export function compareSlots(a: string, b: string): number {
  const dc = slotColumn(a) - slotColumn(b);
  if (dc !== 0) return dc;
  return rowLetterToIndex(slotRowLetter(a)) - rowLetterToIndex(slotRowLetter(b));
}

/** Electrode identity uses color; all data traces are solid. */
export const ADC_ROLE_BORDER_DASH = {
  ur: [] as number[],
  ul: [] as number[],
  ll: [] as number[],
} as const;

/** Short ADC number for titles, e.g. "02". */
export function adcNumFromToken(token: string): string {
  const m = token.match(/ADC(\d+)/i);
  return m ? m[1] : "?";
}

export const REF_A_TOKEN = "REF A (V)";
export const REF_B_TOKEN = "REF B (V)";
export const TEMP_TOKEN = "TEMP";
export const CURR_TOKEN = "CURR (A)";

/** When each temperature sensor is its own token row, the reading is usually in col6 (same as ADC rows). */
const TEMP_SPLIT_VALUE_COL: keyof DataRow = "col6";

function normTokenKey(k: string): string {
  return k
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/\(V\)/g, "");
}

/**
 * Points and Y column for temperature channel 1–6.
 *
 * 1) **Combined row** (common): one `TEMP` token per mux loop with six readings in `col1`…`col6`
 *    (your session file: `TEMP` + 270751, 39752, … in col1–6).
 * 2) **Split rows**: `TEMP01 (V)` … `TEMP06 (V)` or `TEMP1` … `TEMP6`, value in `col6`.
 */
export function resolveTemperatureSeries(
  chartDataMap: Map<string, DataRow[]>,
  col: number
): { points: DataRow[]; yColumn: keyof DataRow; subtitle: string } {
  if (col < 1 || col > 6) {
    return { points: [], yColumn: "col1", subtitle: "" };
  }

  const yCol = `col${col}` as keyof DataRow;

  const combined = chartDataMap.get(TEMP_TOKEN);
  if (combined?.length) {
    return {
      points: combined,
      yColumn: yCol,
      subtitle: `${TEMP_TOKEN} → ${String(yCol)}`,
    };
  }

  const exactAlts = [
    `TEMP0${col} (V)`,
    `TEMP${col} (V)`,
    `TEMP_${col}`,
    `TEMP ${col}`,
    col < 10 ? `TEMP0${col}` : `TEMP${col}`,
    `TEMP${col}`,
  ];
  for (const k of exactAlts) {
    const pts = chartDataMap.get(k);
    if (pts?.length) {
      return {
        points: pts,
        yColumn: TEMP_SPLIT_VALUE_COL,
        subtitle: k,
      };
    }
  }

  const wantShort = `TEMP${col}`;
  const wantPadded = col < 10 ? `TEMP0${col}` : wantShort;
  for (const [k, pts] of chartDataMap) {
    if (!pts?.length) continue;
    const n = normTokenKey(k);
    if (!n.startsWith("TEMP")) continue;
    if (/REF|CURR|ADC|DIFF|DAC/.test(n)) continue;
    if (n === "TEMP") continue;
    if (n === wantPadded || n === wantShort || n === `TEMP_${col}`) {
      return {
        points: pts,
        yColumn: TEMP_SPLIT_VALUE_COL,
        subtitle: k.trim(),
      };
    }
  }

  return { points: [], yColumn: yCol, subtitle: "" };
}

export type RefCheckId =
  | "ref-1a"
  | "ref-1b"
  | "ref-2a"
  | "ref-2b"
  | "ref-3a"
  | "ref-3b"
  | "ref-4a"
  | "ref-4b"
  | "ref-5a"
  | "ref-5b"
  | "ref-6a"
  | "ref-6b";

/** REF A/B column mapping per spec: A col6→1a … col1→3b; B col6→4a … col1→6b. */
export const REF_CHECKBOXES: {
  id: RefCheckId;
  token: string;
  col: keyof DataRow;
  label: string;
}[] = [
  { id: "ref-1a", token: REF_A_TOKEN, col: "col6", label: "REF 1a" },
  { id: "ref-1b", token: REF_A_TOKEN, col: "col5", label: "REF 1b" },
  { id: "ref-2a", token: REF_A_TOKEN, col: "col4", label: "REF 2a" },
  { id: "ref-2b", token: REF_A_TOKEN, col: "col3", label: "REF 2b" },
  { id: "ref-3a", token: REF_A_TOKEN, col: "col2", label: "REF 3a" },
  { id: "ref-3b", token: REF_A_TOKEN, col: "col1", label: "REF 3b" },
  { id: "ref-4a", token: REF_B_TOKEN, col: "col6", label: "REF 4a" },
  { id: "ref-4b", token: REF_B_TOKEN, col: "col5", label: "REF 4b" },
  { id: "ref-5a", token: REF_B_TOKEN, col: "col4", label: "REF 5a" },
  { id: "ref-5b", token: REF_B_TOKEN, col: "col3", label: "REF 5b" },
  { id: "ref-6a", token: REF_B_TOKEN, col: "col2", label: "REF 6a" },
  { id: "ref-6b", token: REF_B_TOKEN, col: "col1", label: "REF 6b" },
];

export const SERIES_PALETTE = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#ca8a04",
  "#9333ea",
  "#db2777",
  "#0891b2",
  "#ea580c",
];
