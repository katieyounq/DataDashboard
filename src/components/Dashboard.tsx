import DataConfigPage from "./DataConfigPage";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import FileUpload from "./FileUpload";
import DataConfigCsvPanel from "./DataConfigCsvPanel";
import RawDataDisplay from "./RawDataDisplay";
import SensorControlDeck from "./SensorControlDeck";
import SingleEndedREPage, { type RERowConfig } from "./SingleEndedREPage";
import CalibrationPage, { type CalibrationFormState, type TargetCalPoint } from "./CalibrationPage";
import PHPage, { type PHRowConfig } from "./PHPage";
import { parseCSV, type DataRow } from "../utils/csvParser";
import { DEFAULT_DENOISE_PARAMS, type DenoiseParams } from "../utils/denoise";
import type { CalibrationEntry, CombPHCalibrationEntry, TargetCalibrationEntry } from "../utils/calibrationStore";
import { getDataTimeBounds, elapsedMs } from "../utils/dataTimeBounds";
import type { RefCheckId } from "../utils/sensorLayout";
import {
  buildEventLatestTimestamps,
  parseDataConfigCsvText,
  parseDataConfigStartTimeMs,
  type DataConfigRowParsed,
} from "../utils/dataConfigCsv";
import { type DataFilter, newFilterId, applyFilters } from "../utils/dataFilters";
import FilterPanel from "./FilterPanel";

/** Empty = same origin (Vite dev proxy forwards /api to the file server). */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const DEFAULT_WINDOW_SIZE = 500;
const POLL_INTERVAL_MS = 250;
const REPLAY_BATCH_SIZE = 300;

interface LiveState {
  tokenMap: Map<string, DataRow[]>;
  tokens: string[];
  allEvents: Set<number>;
  totalRows: number;
  eventLabels: Map<number, string>;
}

function emptyLiveState(): LiveState {
  return {
    tokenMap: new Map(),
    tokens: [],
    allEvents: new Set(),
    totalRows: 0,
    eventLabels: new Map(),
  };
}

export default function Dashboard() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [windowSize, setWindowSize] = useState(DEFAULT_WINDOW_SIZE);
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<"idle" | "live" | "file">("idle");
  const [isPolling, setIsPolling] = useState(false);
  const [hiddenEvents, setHiddenEvents] = useState<Set<number>>(() => new Set());

  const [selectedSlots, setSelectedSlots] = useState<Set<string>>(() => new Set(["1A"]));
  const [showSingleEnded, setShowSingleEnded] = useState(true);
  const [showDiff, setShowDiff] = useState(true);
  const [showSingleEndedRE, setShowSingleEndedRE] = useState(false);
  const [showPH, setShowPH] = useState(false);
  const [selectedRefIds, setSelectedRefIds] = useState<Set<RefCheckId>>(
    () => new Set(["ref-2a", "ref-2b"])
  );
  const [tempCols, setTempCols] = useState<Set<number>>(() => new Set());
  const [currCols, setCurrCols] = useState<Set<number>>(() => new Set());
  const [appPage, setAppPage] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [calibrationEntries, setCalibrationEntries] = useState<CalibrationEntry[]>([]);
  const [combPHEntries, setCombPHEntries] = useState<CombPHCalibrationEntry[]>([]);
  const [dataFilters, setDataFilters] = useState<DataFilter[]>([]);
  const [seReRows, setSeReRows] = useState<RERowConfig[]>([
    { id: "r1", slot: "1A", dacForce: "0.9", refId: "ref-1a" },
    { id: "r2", slot: "3C", dacForce: "0.85", refId: "ref-6b" },
  ]);
  const [phRows, setPhRows] = useState<PHRowConfig[]>([
    { id: "ph-init", slot: "6A", loss: "0.9", refId: "ref-1a", calibrationId: "" },
  ]);
  const [calFormState, setCalFormState] = useState<CalibrationFormState>({
    calSensor: "6A",
    calLoss: "0.9",
    calRefId: "ref-1a",
    calPoints: [
      { id: "cp-1", eventCounters: [1], ph: "7" },
      { id: "cp-2", eventCounters: [2], ph: "7" },
    ],
    regressionResults: { UL: null, UR: null, LL: null },
    hasCalibrated: false,
    addSensor: "6A",
  });
  const [targetCalEntries, setTargetCalEntries] = useState<TargetCalibrationEntry[]>([]);
  const [tcSensors, setTcSensors] = useState<string[]>(["6A"]);
  const [tcLoss, setTcLoss] = useState("0.9");
  const [tcRefId, setTcRefId] = useState<RefCheckId>("ref-1a");
  const [tcPoints, setTcPoints] = useState<TargetCalPoint[]>([
    { id: "tcp-1", eventCounters: [1], concentrationValue: "1", concentrationUnit: "nM" },
    { id: "tcp-2", eventCounters: [2], concentrationValue: "10", concentrationUnit: "nM" },
    { id: "tcp-3", eventCounters: [3], concentrationValue: "100", concentrationUnit: "nM" },
    { id: "tcp-4", eventCounters: [4], concentrationValue: "1000", concentrationUnit: "nM" },
  ]);
  const [combRefAId, setCombRefAId] = useState<RefCheckId>("ref-1a");
  const [combRefBId, setCombRefBId] = useState<RefCheckId>("ref-1b");
  const [combSelectedCalId, setCombSelectedCalId] = useState("");
  const [globalDenoise, setGlobalDenoise] = useState(false);
  const [denoiseParams, setDenoiseParams] = useState<DenoiseParams>({ ...DEFAULT_DENOISE_PARAMS });
  const [timeLowRatio, setTimeLowRatio] = useState(0);
  const [timeHighRatio, setTimeHighRatio] = useState(1);

  const liveRef = useRef<LiveState>(emptyLiveState());
  const [liveSnapshot, setLiveSnapshot] = useState<LiveState>(emptyLiveState());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const replayRef = useRef<{ rows: DataRow[]; index: number } | null>(null);

  const [fileTokenMap, setFileTokenMap] = useState<Map<string, DataRow[]> | null>(null);
  const [fileTokens, setFileTokens] = useState<string[]>([]);
  const [fileEvents, setFileEvents] = useState<Set<number>>(new Set());
  const [fileEventLabels, setFileEventLabels] = useState<Map<number, string>>(() => new Map());
  const [fileTotalRows, setFileTotalRows] = useState(0);

  const [dataConfigEntries, setDataConfigEntries] = useState<DataConfigRowParsed[]>([]);
  const [watchDataConfigServer, setWatchDataConfigServer] = useState(true);
  const configRevision = useRef(0);
  const lastConfigText = useRef<string | null>(null);

  const startPolling = useCallback(async () => {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 2000);
      await fetch(`${API_BASE}/api/reset`, { method: "POST", signal: ctrl.signal });
    } catch {
      // Server might not be running
    }

    if (fileTokenMap && fileTokenMap.size > 0) {
      const allRows: DataRow[] = [];
      for (const rows of fileTokenMap.values()) {
        allRows.push(...rows);
      }
      allRows.sort((a, b) => a.timestamp - b.timestamp);
      replayRef.current = { rows: allRows, index: 0 };
    } else {
      replayRef.current = null;
    }

    liveRef.current = emptyLiveState();
    setLiveSnapshot(emptyLiveState());
    setHiddenEvents(new Set());
    setMode("live");
    setIsPolling(true);
    setFileName("Live Stream");
  }, [fileTokenMap]);

  const resumePolling = useCallback(() => {
    setIsPolling(true);
  }, []);

  const stopPolling = useCallback(() => {
    setIsPolling(false);
  }, []);

  const doPoll = useCallback(async () => {
    let newRows: DataRow[] = [];

    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${API_BASE}/api/poll`, { signal: ctrl.signal });
      const data = await res.json();
      if (data.rows && data.rows.length > 0) {
        newRows = data.rows;
      }
    } catch {
      // Server not available — fall through to replay
    }

    if (newRows.length === 0 && replayRef.current) {
      const replay = replayRef.current;
      const end = Math.min(replay.index + REPLAY_BATCH_SIZE, replay.rows.length);
      if (replay.index < end) {
        newRows = replay.rows.slice(replay.index, end);
        replay.index = end;
      }
      if (end >= replay.rows.length) {
        replayRef.current = null;
      }
    }

    if (newRows.length === 0) return;

    const live = liveRef.current;

    for (const row of newRows) {
      const token = row.token;
      if (!live.tokenMap.has(token)) {
        live.tokenMap.set(token, []);
        live.tokens.push(token);
      }
      live.tokenMap.get(token)!.push(row);
      live.allEvents.add(row.eventCounter);
      const caption =
        typeof row.eventLabel === "string" ? row.eventLabel.trim() : "";
      if (caption) {
        live.eventLabels.set(row.eventCounter, caption);
      }
    }

    live.totalRows += newRows.length;

    setLiveSnapshot({
      tokenMap: new Map(live.tokenMap),
      tokens: [...live.tokens],
      allEvents: new Set(live.allEvents),
      totalRows: live.totalRows,
      eventLabels: new Map(live.eventLabels),
    });
  }, []);

  const pollDataConfig = useCallback(async () => {
    const revision = configRevision.current;
    try {
      const res = await fetch(`${API_BASE}/api/data-config-csv/document`);
      if (!res.ok) return;
      const text = await res.text();
      if (revision === configRevision.current && text !== lastConfigText.current) {
        lastConfigText.current = text;
        setDataConfigEntries(parseDataConfigCsvText(text));
      }
    } catch {
      /* API off */
    }
  }, []);

  useEffect(() => {
    if (!watchDataConfigServer) return;
    void pollDataConfig();
    const id = setInterval(pollDataConfig, 2000);
    return () => clearInterval(id);
  }, [watchDataConfigServer, pollDataConfig]);

  useEffect(() => {
    if (!isPolling) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    doPoll();
    pollTimerRef.current = setInterval(doPoll, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isPolling, doPoll]);

  const handleFileLoaded = useCallback((text: string, name: string) => {
    setIsLoading(true);
    setFileName(name);
    setMode("file");
    setIsPolling(false);

    setTimeout(() => {
      try {
        const parsed = parseCSV(text);
        setFileTokenMap(parsed.tokenMap);
        setFileTokens(parsed.tokens);
        setFileEvents(new Set(parsed.eventColors.keys()));
        setFileEventLabels(new Map(parsed.eventLabels));
        setHiddenEvents(new Set());
        setFileTotalRows(parsed.allRows.length);
      } catch (e) {
        console.error("Parse error:", e);
      } finally {
        setIsLoading(false);
      }
    }, 50);
  }, []);

  const handleLoadSample = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/sample.csv");
      const text = await res.text();
      handleFileLoaded(text, "Sample Data (full file)");
    } catch (e) {
      console.error("Failed to load sample:", e);
      setIsLoading(false);
    }
  }, [handleFileLoaded]);

  const displayTokenMap = mode === "live" ? liveSnapshot.tokenMap : fileTokenMap;
  const displayEvents = mode === "live" ? Array.from(liveSnapshot.allEvents).sort((a, b) => a - b) : Array.from(fileEvents).sort((a, b) => a - b);
  const displayEventLabels = mode === "live" ? liveSnapshot.eventLabels : fileEventLabels;
  const displayTotalRows = mode === "live" ? liveSnapshot.totalRows : fileTotalRows;



  const experimentStart = useMemo(() => {
    for (const points of displayTokenMap?.values() ?? []) {
      if (points.length) return parseDataConfigStartTimeMs(points[0].startTime);
    }
    return null;
  }, [displayTokenMap]);
  const dataConfigScoped = useMemo(
    () => dataConfigEntries.filter((row) => row.startTimeMs === experimentStart),
    [dataConfigEntries, experimentStart]
  );

  const handleToggleEvent = useCallback((evt: number) => {
    setHiddenEvents((prev) => {
      const next = new Set(prev);
      if (next.has(evt)) next.delete(evt);
      else next.add(evt);
      return next;
    });
  }, []);

  const windowedTokenMap = useMemo(() => {
    if (!displayTokenMap) return null;
    const windowed = new Map<string, DataRow[]>();
    const filterByEvent = hiddenEvents.size > 0;
    for (const [token, points] of displayTokenMap) {
      const filtered = filterByEvent
        ? points.filter((p) => !hiddenEvents.has(p.eventCounter))
        : points;
      if (windowSize > 0 && filtered.length > windowSize) {
        windowed.set(token, filtered.slice(filtered.length - windowSize));
      } else {
        windowed.set(token, filtered);
      }
    }
    return windowed;
  }, [displayTokenMap, windowSize, hiddenEvents, liveSnapshot]);

  const filteredTokenMap = useMemo(() => {
    if (!windowedTokenMap) return null;
    return applyFilters(windowedTokenMap, dataFilters);
  }, [windowedTokenMap, dataFilters]);

  const dataTimeBounds = useMemo(
    () => (windowedTokenMap ? getDataTimeBounds(windowedTokenMap) : null),
    [windowedTokenMap]
  );

  const page1ChartTokenMap = useMemo(() => {
    if (!filteredTokenMap) return null;
    if (!dataTimeBounds) return filteredTokenMap;
    const span = dataTimeBounds.max - dataTimeBounds.min;
    const lo = dataTimeBounds.min + span * timeLowRatio;
    const hi = dataTimeBounds.min + span * timeHighRatio;
    if (hi <= lo) return filteredTokenMap;
    const out = new Map<string, DataRow[]>();
    for (const [k, pts] of filteredTokenMap) {
      out.set(
        k,
        pts.filter((p) => { const t = elapsedMs(p); return t >= lo && t <= hi; })
      );
    }
    return out;
  }, [filteredTokenMap, dataTimeBounds, timeLowRatio, timeHighRatio]);

  const handleRangeSelect = useCallback((startMs: number, endMs: number) => {
    const f: DataFilter = {
      id: newFilterId(),
      name: `Filter ${dataFilters.length + 1}`,
      startElapsedMs: Math.min(startMs, endMs),
      endElapsedMs: Math.max(startMs, endMs),
      enabled: true,
    };
    setDataFilters((prev) => [...prev, f]);
  }, [dataFilters.length]);

  const allEventsLatestTimestamp = useMemo(() => {
    if (!displayTokenMap || displayTokenMap.size === 0) return new Map<number, number>();
    return buildEventLatestTimestamps(displayTokenMap);
  }, [displayTokenMap]);

  const onReplaceDataConfigEntries = useCallback((rows: DataConfigRowParsed[]) => {
    configRevision.current++;
    setWatchDataConfigServer(false);
    setDataConfigEntries(rows);
  }, []);

  const resetPage1TimeRange = useCallback(() => {
    setTimeLowRatio(0);
    setTimeHighRatio(1);
  }, []);

  const hasData = (displayTokenMap && displayTokenMap.size > 0) || mode === "live";

  const toggleSlot = useCallback((slot: string) => {
    setSelectedSlots((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  }, []);

  const toggleRef = useCallback((id: RefCheckId) => {
    setSelectedRefIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleTempCol = useCallback((n: number) => {
    setTempCols((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }, []);

  const toggleCurrCol = useCallback((n: number) => {
    setCurrCols((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }, []);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="header-left">
          <h1>
            {appPage === 1
              ? "Raw Data Display"
              : appPage === 2
                ? "Single-ended − Reference Electrode"
                : appPage === 3
                  ? "Calibration"
                  : appPage === 5 ? "Data Configuration" : "pH Display"}
          </h1>
          <span className="header-subtitle">
            {appPage === 1
              ? "24-slot sensor layout · live or file"
              : appPage === 2
                ? "(ADC ÷ loss) − REF per loop · page 2"
                : appPage === 3
                  ? "Sensor calibration · page 3"
                  : appPage === 5 ? "Current experiment · sensors and events" : "pH = (ADC/loss − REF − offset) ÷ sensitivity · page 4"}
          </span>
        </div>
        <div className="header-right">
          {hasData && (
            <nav className="page-nav">
              {([
                [1, "Raw Data"],
                [2, "SE − RE"],
                [3, "Calibration"],
                [4, "pH Display"],
                [5, "Data Configuration"],
              ] as [1|2|3|4|5, string][]).map(([pg, label]) => (
                <button
                  key={pg}
                  type="button"
                  className={`page-nav-btn${appPage === pg ? " page-nav-active" : ""}`}
                  onClick={() => setAppPage(pg)}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}
          {hasData && (
            <div className="denoise-global-controls">
              <label className="denoise-toggle-label">
                <input
                  type="checkbox"
                  checked={globalDenoise}
                  onChange={(e) => setGlobalDenoise(e.target.checked)}
                />
                Denoise All
              </label>
              {globalDenoise && (
                <>
                  <div className="denoise-param-group">
                    <span className="denoise-param-label">Window:</span>
                    <input
                      type="number"
                      className="denoise-param-input"
                      value={denoiseParams.windowSize}
                      min={3}
                      max={101}
                      step={2}
                      onChange={(e) =>
                        setDenoiseParams((p) => ({
                          ...p,
                          windowSize: Math.max(3, parseInt(e.target.value) || 3),
                        }))
                      }
                    />
                  </div>
                  <div className="denoise-param-group">
                    <span className="denoise-param-label">Threshold:</span>
                    <input
                      type="number"
                      className="denoise-param-input"
                      value={denoiseParams.threshold}
                      min={0.5}
                      max={20}
                      step={0.5}
                      onChange={(e) =>
                        setDenoiseParams((p) => ({
                          ...p,
                          threshold: Math.max(0.5, parseFloat(e.target.value) || 5),
                        }))
                      }
                    />
                  </div>
                  <span className="denoise-algo-label">MAD spike removal</span>
                </>
              )}
            </div>
          )}
          <FileUpload onFileLoaded={handleFileLoaded} fileName={fileName} />
          <DataConfigCsvPanel
            apiBase={API_BASE}
            entryCount={dataConfigEntries.length}
            watchServer={watchDataConfigServer}
            onWatchServerChange={setWatchDataConfigServer}
            onReplaceEntries={onReplaceDataConfigEntries}
          />
          {mode === "live" ? (
            <button
              className={`live-btn ${isPolling ? "active" : ""}`}
              onClick={isPolling ? stopPolling : resumePolling}
            >
              {isPolling ? "Stop Live" : "Resume Live"}
            </button>
          ) : (
            <button className="live-btn" onClick={startPolling}>
              Start Live
            </button>
          )}
        </div>
      </header>

      {isLoading ? (
        <div className="empty-state">
          <div className="loading-spinner" />
          <h2>Loading data...</h2>
          <p>Parsing CSV file, this may take a moment for large files.</p>
        </div>
      ) : !hasData ? (
        <div className="empty-state">
          <div className="empty-icon">📊</div>
          <h2>Upload a CSV or start live streaming</h2>
          <p>
            Upload a file, or click Start Live with the file watcher (
            <code>node server.cjs</code>
            ).
          </p>
          <div className="empty-actions">
            <button className="load-sample-btn" onClick={handleLoadSample}>
              Load Sample Data
            </button>
            <button className="live-btn" onClick={startPolling}>
              Start Live Stream
            </button>
          </div>
        </div>
      ) : appPage === 5 ? (
        <DataConfigPage key={experimentStart ?? "no-session"} entries={dataConfigEntries} experimentStart={experimentStart}
          onSave={(rows) => {
            configRevision.current++;
            setWatchDataConfigServer(false);
            setDataConfigEntries((previous) => [...previous.filter((row) => row.startTimeMs !== experimentStart), ...rows]);
          }} />
      ) : appPage === 2 && filteredTokenMap ? (
        <div className="dashboard-body dashboard-body-stacked">
          <div className="chart-area raw-chart-area se-re-chart-area-outer">
            <div className="chart-toolbar">
              <span className="toolbar-info">
                {mode === "live" && (
                  <span className={`live-indicator ${isPolling ? "pulsing" : ""}`} />
                )}
                {displayTotalRows.toLocaleString()} rows loaded
              </span>
            </div>
            <FilterPanel filters={dataFilters} onFiltersChange={setDataFilters} />
            <SingleEndedREPage
              windowedTokenMap={filteredTokenMap}
              windowSize={windowSize}
              onWindowSizeChange={setWindowSize}
              rows={seReRows}
              onRowsChange={setSeReRows}
              events={displayEvents}
              eventLabels={displayEventLabels}
              hiddenEvents={hiddenEvents}
              onToggleEvent={handleToggleEvent}
              onSetHiddenEvents={setHiddenEvents}
              isPolling={isPolling}
              onTogglePolling={isPolling ? stopPolling : resumePolling}
              totalRows={displayTotalRows}
              mode={mode}
              dataConfigEntries={dataConfigScoped}
              allEventsLatestTimestamp={allEventsLatestTimestamp}
              onRangeSelect={handleRangeSelect}
              globalDenoise={globalDenoise}
              denoiseParams={denoiseParams}
            />
          </div>
        </div>
      ) : appPage === 3 && filteredTokenMap ? (
        <div className="dashboard-body dashboard-body-stacked">
          <div className="chart-area raw-chart-area">
            <div className="chart-toolbar">
              <span className="toolbar-info">
                {mode === "live" && (
                  <span className={`live-indicator ${isPolling ? "pulsing" : ""}`} />
                )}
                {displayTotalRows.toLocaleString()} rows loaded
              </span>
            </div>
            <FilterPanel filters={dataFilters} onFiltersChange={setDataFilters} />
            <CalibrationPage
              windowedTokenMap={filteredTokenMap}
              events={displayEvents}
              eventLabels={displayEventLabels}
              dataConfigEntries={dataConfigScoped}
              calibrationEntries={calibrationEntries}
              onCalibrationEntriesChange={setCalibrationEntries}
              formState={calFormState}
              onFormStateChange={setCalFormState}
              allEventsLatestTimestamp={allEventsLatestTimestamp}
              combPHEntries={combPHEntries}
              onCombPHEntriesChange={setCombPHEntries}
              dataFilters={dataFilters}
              targetCalEntries={targetCalEntries}
              onTargetCalEntriesChange={setTargetCalEntries}
              tcSensors={tcSensors}
              onTcSensorsChange={setTcSensors}
              tcLoss={tcLoss}
              onTcLossChange={setTcLoss}
              tcRefId={tcRefId}
              onTcRefIdChange={setTcRefId}
              tcPoints={tcPoints}
              onTcPointsChange={setTcPoints}
              denoiseParams={denoiseParams}
            />
          </div>
        </div>
      ) : appPage === 4 && filteredTokenMap ? (
        <div className="dashboard-body dashboard-body-stacked">
          <div className="chart-area raw-chart-area se-re-chart-area-outer">
            <div className="chart-toolbar">
              <span className="toolbar-info">
                {mode === "live" && (
                  <span className={`live-indicator ${isPolling ? "pulsing" : ""}`} />
                )}
                {displayTotalRows.toLocaleString()} rows loaded
              </span>
            </div>
            <FilterPanel filters={dataFilters} onFiltersChange={setDataFilters} />
            <PHPage
              windowedTokenMap={filteredTokenMap}
              windowSize={windowSize}
              onWindowSizeChange={setWindowSize}
              events={displayEvents}
              eventLabels={displayEventLabels}
              hiddenEvents={hiddenEvents}
              onToggleEvent={handleToggleEvent}
              onSetHiddenEvents={setHiddenEvents}
              rows={phRows}
              onRowsChange={setPhRows}
              isPolling={isPolling}
              onTogglePolling={isPolling ? stopPolling : resumePolling}
              totalRows={displayTotalRows}
              mode={mode}
              dataConfigEntries={dataConfigScoped}
              calibrationEntries={calibrationEntries}
              combPHEntries={combPHEntries}
              allEventsLatestTimestamp={allEventsLatestTimestamp}
              onRangeSelect={handleRangeSelect}
              globalDenoise={globalDenoise}
              denoiseParams={denoiseParams}
              combRefAId={combRefAId}
              onCombRefAIdChange={setCombRefAId}
              combRefBId={combRefBId}
              onCombRefBIdChange={setCombRefBId}
              combSelectedCalId={combSelectedCalId}
              onCombSelectedCalIdChange={setCombSelectedCalId}
            />
          </div>
        </div>
      ) : (
        <div className="dashboard-body dashboard-body-stacked">
          <div className="chart-area raw-chart-area">
            <div className="chart-toolbar">
              <span className="toolbar-info">
                {mode === "live" && (
                  <span className={`live-indicator ${isPolling ? "pulsing" : ""}`} />
                )}
                {displayTotalRows.toLocaleString()} rows loaded
              </span>
            </div>
            {filteredTokenMap && (
              <RawDataDisplay
                windowedTokenMap={filteredTokenMap}
                dataTimeBounds={dataTimeBounds}
                timeLowRatio={timeLowRatio}
                timeHighRatio={timeHighRatio}
                selectedSlots={selectedSlots}
                showSingleEnded={showSingleEnded}
                showDiff={showDiff}
                showSingleEndedRE={showSingleEndedRE}
                showPH={showPH}
                selectedRefIds={selectedRefIds}
                tempCols={tempCols}
                currCols={currCols}
                events={displayEvents}
                eventLabels={displayEventLabels}
                dataConfigEntries={dataConfigScoped}
                onRangeSelect={handleRangeSelect}
                globalDenoise={globalDenoise}
                denoiseParams={denoiseParams}
              />
            )}
          </div>
          <SensorControlDeck
            windowSize={windowSize}
            onWindowSizeChange={setWindowSize}
            dataTimeBounds={dataTimeBounds}
            timeLowRatio={timeLowRatio}
            timeHighRatio={timeHighRatio}
            onTimeLowRatioChange={setTimeLowRatio}
            onTimeHighRatioChange={setTimeHighRatio}
            onResetTimeRange={resetPage1TimeRange}
            selectedSlots={selectedSlots}
            onToggleSlot={toggleSlot}
            showSingleEnded={showSingleEnded}
            onToggleSingleEnded={() => setShowSingleEnded((v) => !v)}
            showDiff={showDiff}
            onToggleDiff={() => setShowDiff((v) => !v)}
            showSingleEndedRE={showSingleEndedRE}
            onToggleSingleEndedRE={() => setShowSingleEndedRE((v) => !v)}
            showPH={showPH}
            onTogglePH={() => setShowPH((v) => !v)}
            selectedRefIds={selectedRefIds}
            onToggleRef={toggleRef}
            tempCols={tempCols}
            onToggleTempCol={toggleTempCol}
            currCols={currCols}
            onToggleCurrCol={toggleCurrCol}
            events={displayEvents}
            eventLabels={displayEventLabels}
            hiddenEvents={hiddenEvents}
            onToggleEvent={handleToggleEvent}
            onSetHiddenEvents={setHiddenEvents}
            eventLatestTimestamp={allEventsLatestTimestamp}
            dataConfigEntries={dataConfigScoped}
            isPolling={isPolling}
            onTogglePolling={isPolling ? stopPolling : resumePolling}
            totalRows={displayTotalRows}
            mode={mode}
          />
          <FilterPanel filters={dataFilters} onFiltersChange={setDataFilters} />
        </div>
      )}
    </div>
  );
}
