import Papa from "papaparse";
import { parseDataConfigCsvText, type DataConfigRowParsed } from "./dataConfigCsv";

export function editConfigCell(row: DataConfigRowParsed, column: number, value: string): DataConfigRowParsed {
  if (column < 2 || !row.columns || !row.headers) return row;
  const columns = [...row.columns];
  columns[column] = value;
  return parseDataConfigCsvText(Papa.unparse([row.headers, columns], { delimiter: "\t" }))[0] ?? row;
}

export function serializeConfig(rows: DataConfigRowParsed[]): string {
  if (!rows.length) return "";
  const headers = rows[0].headers ?? [];
  return Papa.unparse([headers, ...rows.map((row) => row.columns ?? [])], { delimiter: "\t", newline: "\r\n" }) + "\r\n";
}

export function downloadConfig(rows: DataConfigRowParsed[]): void {
  if (!rows.length) return;
  const url = URL.createObjectURL(new Blob([serializeConfig(rows)], { type: "text/tab-separated-values;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `DataConfig-${new Date(rows[0].startTimeMs).toISOString().replace(/[:.]/g, "-")}.csv`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function representativeSensorRow(rows: DataConfigRowParsed[]): number {
  let best = 0, score = -1;
  rows.forEach((row, i) => {
    const count = row.headers?.reduce((sum, header, col) => sum + (/^[ABCD][1-6]$/i.test(header.trim()) && !!row.columns?.[col]?.trim() && row.columns[col].trim().toUpperCase() !== header.trim().toUpperCase() ? 1 : 0), 0) ?? 0;
    if (count > score) { best = i; score = count; }
  });
  return best;
}
