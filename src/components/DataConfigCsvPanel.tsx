import { useCallback, useEffect, useState } from "react";
import {
  parseDataConfigCsvText,
  type DataConfigRowParsed,
} from "../utils/dataConfigCsv";

interface DataConfigCsvPanelProps {
  apiBase: string;
  entryCount: number;
  watchServer: boolean;
  onWatchServerChange: (on: boolean) => void;
  onReplaceEntries: (rows: DataConfigRowParsed[]) => void;
  disabled?: boolean;
}

export default function DataConfigCsvPanel({
  apiBase,
  entryCount,
  watchServer,
  onWatchServerChange,
  onReplaceEntries,
  disabled,
}: DataConfigCsvPanelProps) {
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [serverPath, setServerPath] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/status`);
        const data = (await res.json()) as { dataConfigCsvPath?: string };
        if (!cancelled && data.dataConfigCsvPath) setServerPath(data.dataConfigCsvPath);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const onPickFile = useCallback(
    (file: File) => {
      if (!file.name.toLowerCase().endsWith(".csv")) {
        setHint("Choose a .csv file (e.g. DataConfig.csv)");
        setTimeout(() => setHint(null), 4000);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        const rows = parseDataConfigCsvText(text);
        setUploadName(file.name);
        setHint(null);
        onReplaceEntries(rows);
      };
      reader.readAsText(file);
    },
    [onReplaceEntries]
  );

  return (
    <div className={`config-file-panel data-config-csv-panel ${disabled ? "config-file-panel--disabled" : ""}`}>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPickFile(file);
          e.target.value = "";
        }}
        id="dataconfig-csv-input"
        className="file-input"
      />
      <label
        htmlFor="dataconfig-csv-input"
        className="config-file-label"
        title="Tab-separated CSV: DataConfig.csv (columns startTime, eventCounter, …, eventName)"
      >
        {uploadName ? (
          <span className="config-file-name">📋 {uploadName}</span>
        ) : (
          <span>DataConfig.csv</span>
        )}
      </label>
      <label
        className="config-watch-label"
        title="Append new lines from the server’s DataConfig.csv file (same folder as session CSV, or DATA_CONFIG_PATH)"
      >
        <input
          type="checkbox"
          checked={watchServer}
          disabled={!!disabled}
          onChange={(e) => onWatchServerChange(e.target.checked)}
        />
        <span>Watch</span>
      </label>
      <span className="data-config-count" title="Configuration rows (all original columns retained)">
        {entryCount.toLocaleString()} rows
      </span>
      {serverPath && (
        <span className="config-server-path" title="Server watches this .csv path when Watch is on">
          {serverPath}
        </span>
      )}
      {hint && <span className="config-hint">{hint}</span>}
    </div>
  );
}
