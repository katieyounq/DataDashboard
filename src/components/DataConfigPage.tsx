import { useEffect, useMemo, useState } from "react";
import { colorForEventName, parseDataConfigCsvText, type DataConfigRowParsed } from "../utils/dataConfigCsv";
import { downloadConfig, editConfigCell, representativeSensorRow, serializeConfig } from "../utils/configEditor";

interface Props {
  entries: DataConfigRowParsed[];
  experimentStart: number | null;
  onSave: (rows: DataConfigRowParsed[]) => void;
}

export default function DataConfigPage({ entries, experimentStart, onSave }: Props) {
  const current = useMemo(() => entries.filter((row) => row.startTimeMs === experimentStart), [entries, experimentStart]);
  const [draft, setDraft] = useState(current);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [sensorRow, setSensorRow] = useState(representativeSensorRow(current));
  useEffect(() => {
    if (!dirty) { setDraft(current); setSensorRow(representativeSensorRow(current)); }
  }, [current, dirty]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const headers = draft[0]?.headers ?? [];
  const change = (index: number, column: number, value: string) => {
    setDraft((rows) => rows.map((row, i) => i === index ? editConfigCell(row, column, value) : row));
    setDirty(true); setMessage("Unsaved changes");
  };
  const save = () => {
    try {
      localStorage.setItem(`data-config:${experimentStart}`, serializeConfig(draft));
      onSave(draft); setDirty(false);
      setMessage("Saved in this browser and applied to charts. Download to keep an updated CSV file. Server Watch is paused.");
    } catch { setMessage("Could not save in this browser. Your edits are still here; download them before leaving."); }
  };
  return <main className="config-editor">
    <div className="config-editor-toolbar">
      <div><h2>Experiment configuration</h2><p>{experimentStart === null ? "Load experiment data first." : `Session start: ${new Date(experimentStart).toLocaleString()}`}</p></div>
      <button disabled={!draft.length} onClick={save}>Save changes</button>
      <button disabled={!draft.length} onClick={() => downloadConfig(draft)}>Download experiment CSV{dirty ? " (with edits)" : ""}</button>
      <button disabled={experimentStart === null} onClick={() => {
        try {
          const text = localStorage.getItem(`data-config:${experimentStart}`);
          if (!text) { setMessage("No saved configuration for this experiment."); return; }
          const rows = parseDataConfigCsvText(text).filter((row) => row.startTimeMs === experimentStart);
          setDraft(rows); onSave(rows); setDirty(false); setMessage("Restored saved configuration and updated charts. Server Watch is paused.");
        } catch { setMessage("Could not restore the saved configuration."); }
      }}>Restore browser save</button>
    </div>
    <p role="status">{message}</p>
    {!current.length ? <p>No configuration rows match this experiment’s start time. Upload its DataConfig.csv using the control above. Rows from other experiments are excluded.</p> : <>
      <section><h3>Sensor configuration · 4 × 6 wells</h3>
        <label>Show layout from event <select value={sensorRow} onChange={(e) => setSensorRow(Number(e.target.value))}>
          {draft.map((row, i) => <option key={i} value={i}>{row.eventCounter} — {row.eventName}</option>)}
        </select></label>
        <p>One layout is shown at a time. Sensor IDs may differ between wells; editing a well updates only the selected event row.</p>
        <div className="config-sensor-grid">{["A", "B", "C", "D"].flatMap((letter) => Array.from({ length: 6 }, (_, i) => {
          const well = `${letter}${i + 1}`;
          const col = headers.findIndex((header) => header.trim().toUpperCase() === well);
          return <label key={well}><strong>{well}</strong><input aria-label={`Sensor ID ${well}`} disabled={col < 0} placeholder={col < 0 ? "Column not provided" : "Empty"}
            value={col < 0 ? "" : draft[sensorRow]?.columns?.[col] ?? ""} onChange={(e) => change(sensorRow, col, e.target.value)} /></label>;
        }))}</div>
      </section>
      <section><h3>Event counter and name</h3><table className="config-events"><thead><tr><th>Event counter</th><th>Color</th><th>Event name</th></tr></thead><tbody>
        {draft.map((row, i) => <tr key={i}><td>{row.eventCounter}</td><td><span className="config-color-swatch" style={{ backgroundColor: colorForEventName(row.eventName) }} /></td>
          <td><input aria-label={`Event name row ${i + 1}`} value={row.columns?.[3] ?? ""} onChange={(e) => change(i, 3, e.target.value)} /></td></tr>)}
      </tbody></table><p>Save changes to update event names and colors throughout the dashboard.</p></section>
      <section><h3>All configuration fields</h3><p>Start time and event counter are read-only. Empty cells and additional columns are retained.</p>
        <div className="config-fields-scroll"><table><thead><tr>{headers.map((header, i) => <th key={i}>{header || `Column ${i + 1}`}</th>)}</tr></thead><tbody>
          {draft.map((row, ri) => <tr key={ri}>{headers.map((_, ci) => <td key={ci}>{ci < 2 ? row.columns?.[ci] : <input aria-label={`Row ${ri + 1}, ${headers[ci]}`} value={row.columns?.[ci] ?? ""} onChange={(e) => change(ri, ci, e.target.value)} />}</td>)}</tr>)}
        </tbody></table></div>
      </section>
    </>}
  </main>;
}
