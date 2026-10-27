import Papa from "papaparse";

export interface DataRow {
  startTime: string;
  currentTime: string;
  token: string;
  eventCounter: number;
  stepCounter: number;
  dacForce: number;
  col1: number;
  col2: number;
  col3: number;
  col4: number;
  col5: number;
  col6: number;
  loopCounter: number;
  /** User-defined label from the instrument (optional column in the TSV). */
  eventLabel?: string;
  timestamp: number; // parsed ms since epoch
  elapsedSeconds: number; // seconds since startTime
}

export interface TokenData {
  token: string;
  points: DataRow[];
}

export interface ParsedData {
  allRows: DataRow[];
  tokenMap: Map<string, DataRow[]>;
  tokens: string[];
  eventColors: Map<number, string>;
  /** Latest non-empty label per event counter (from file). */
  eventLabels: Map<number, string>;
  startTime: Date;
}

const EVENT_COLORS: Record<number, string> = {
  0: "#1f77b4",
  1: "#d62728",
  2: "#2ca02c",
  3: "#ff7f0e",
  4: "#9467bd",
  5: "#8c564b",
  6: "#e377c2",
  7: "#7f7f7f",
  8: "#bcbd22",
  9: "#17becf",
};

export function getEventColor(event: number): string {
  return EVENT_COLORS[event % Object.keys(EVENT_COLORS).length] || "#333";
}

/** Column in each data row that carries the user-defined event caption (after the 13 core fields). */
const DEFAULT_EVENT_LABEL_COL = 13;

function normalizeHeaderName(cell: string): string {
  return (cell || "").trim().toLowerCase().replace(/\s+/g, "");
}

/** Resolve which column holds the event label: named header, else the 14th field (index 13). */
export function findEventLabelColumnIndex(header: string[]): number {
  const idx = header.findIndex((cell) => {
    const h = normalizeHeaderName(cell);
    return (
      h === "eventlabel" ||
      h === "eventname" ||
      h === "eventcaption" ||
      h === "eventtitle" ||
      h === "eventdescription" ||
      h === "eventcomment" ||
      h === "label"
    );
  });
  if (idx >= 0) return idx;
  return DEFAULT_EVENT_LABEL_COL;
}

/** Legend / chart text: only uses labels present in the file or live stream (`eventLabel` column). */
export function resolveEventCaption(
  eventCounter: number,
  dynamicLabels: Map<number, string>
): string {
  const fromData = dynamicLabels.get(eventCounter)?.trim();
  if (fromData) return fromData;
  return `Event ${eventCounter}`;
}

function parseTimestamp(dateStr: string): Date {
  // Format: "04/25/2025 10:43:19" or "04/25/2025 10:43:19.917"
  const [datePart, timePart] = dateStr.trim().split("\t")[0].split(" ");
  if (!datePart || !timePart) return new Date(dateStr);
  const [month, day, year] = datePart.split("/");
  const [hours, minutes, secMs] = timePart.split(":");
  const [seconds, ms] = (secMs || "0").split(".");
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
    ms ? Number(ms) : 0
  );
}

export function parseCSV(text: string): ParsedData {
  const result = Papa.parse(text, {
    delimiter: "\t",
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  const header = rows[0];
  if (!header) throw new Error("No header row found");

  const labelColIndex = findEventLabelColumnIndex(header);

  const startTimeStr = rows[1]?.[0];
  const startTime = startTimeStr ? parseTimestamp(startTimeStr) : new Date();
  const startMs = startTime.getTime();

  const allRows: DataRow[] = [];
  const tokenMap = new Map<string, DataRow[]>();
  const tokenSet = new Set<string>();
  const eventSet = new Set<number>();
  const eventLabels = new Map<number, string>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 13) continue;

    const token = (row[2] || "").trim();
    const currentTimeStr = (row[1] || "").trim();
    const timestamp = parseTimestamp(currentTimeStr);
    const timestampMs = timestamp.getTime();
    const eventCounter = Number(row[3]) || 0;

    const rawLabel =
      labelColIndex >= 0 && row.length > labelColIndex
        ? (row[labelColIndex] || "").trim()
        : "";
    if (rawLabel) {
      eventLabels.set(eventCounter, rawLabel);
    }

    const dataRow: DataRow = {
      startTime: (row[0] || "").trim(),
      currentTime: currentTimeStr,
      token,
      eventCounter,
      stepCounter: Number(row[4]) || 0,
      dacForce: Number(row[5]) || 0,
      col1: Number(row[6]) || 0,
      col2: Number(row[7]) || 0,
      col3: Number(row[8]) || 0,
      col4: Number(row[9]) || 0,
      col5: Number(row[10]) || 0,
      col6: Number(row[11]) || 0,
      loopCounter: Number(row[12]) || 0,
      ...(rawLabel ? { eventLabel: rawLabel } : {}),
      timestamp: timestampMs,
      elapsedSeconds: (timestampMs - startMs) / 1000,
    };

    allRows.push(dataRow);
    tokenSet.add(token);
    eventSet.add(eventCounter);

    if (!tokenMap.has(token)) {
      tokenMap.set(token, []);
    }
    tokenMap.get(token)!.push(dataRow);
  }

  const eventColors = new Map<number, string>();
  for (const evt of eventSet) {
    eventColors.set(evt, getEventColor(evt));
  }

  return {
    allRows,
    tokenMap,
    tokens: Array.from(tokenSet),
    eventColors,
    eventLabels,
    startTime,
  };
}

export function parseCSVIncremental(
  text: string,
  existingData: ParsedData,
  lastLineCount: number
): { data: ParsedData; newLineCount: number } {
  const lines = text.split("\n");
  const newLines = lines.slice(lastLineCount);

  if (newLines.length === 0) {
    return { data: existingData, newLineCount: lines.length };
  }

  const newText = [lines[0], ...newLines].join("\n");
  const newParsed = parseCSV(newText);

  for (const row of newParsed.allRows) {
    existingData.allRows.push(row);
    if (!existingData.tokenMap.has(row.token)) {
      existingData.tokenMap.set(row.token, []);
      existingData.tokens.push(row.token);
    }
    existingData.tokenMap.get(row.token)!.push(row);
    existingData.eventColors.set(row.eventCounter, getEventColor(row.eventCounter));
    const L = row.eventLabel?.trim();
    if (L) existingData.eventLabels.set(row.eventCounter, L);
  }

  return { data: existingData, newLineCount: lines.length };
}
