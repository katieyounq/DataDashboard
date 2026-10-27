const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

function resolveCsvPath() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  if (process.env.CSV_PATH) return path.resolve(process.env.CSV_PATH);
  return path.resolve(__dirname, "public", "sample.csv");
}

const csvPath = resolveCsvPath();

function resolveDataConfigCsvPath() {
  if (process.env.DATA_CONFIG_PATH) return path.resolve(process.env.DATA_CONFIG_PATH);
  return path.join(path.dirname(csvPath), "DataConfig.csv");
}

const dataConfigCsvPath = resolveDataConfigCsvPath();

// Max bytes to read per poll - prevents blocking on huge files
const MAX_CHUNK_BYTES = 512 * 1024; // 512 KB per poll

let headerLine = "";
let byteOffset = 0;
let lineCount = 0;
let headerParsed = false;
let startTimeMs = 0;
let partialLine = ""; // leftover from previous chunk boundary

/** DataConfig.csv: only startTime (col0), eventCounter (col1), eventName (col3). */
let dcByteOffset = 0;
let dcPartialLine = "";
let dcHeaderSkipped = false;
let dcLineCount = 0;

function parseTimestamp(dateStr) {
  const [datePart, timePart] = dateStr.trim().split(" ");
  if (!datePart || !timePart) return Date.now();
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
  ).getTime();
}

function parseLine(line) {
  const cols = line.split("\t");
  if (cols.length < 13) return null;

  const token = (cols[2] || "").trim();
  const currentTimeStr = (cols[1] || "").trim();
  const timestampMs = parseTimestamp(currentTimeStr);
  const eventCounter = Number(cols[3]) || 0;

  // Optional 14th tab field: user-defined caption for this event (must match dashboard parser).
  const eventLabel =
    cols.length > 13 ? String(cols[13] ?? "").trim() : "";

  return {
    startTime: (cols[0] || "").trim(),
    currentTime: currentTimeStr,
    token,
    eventCounter,
    stepCounter: Number(cols[4]) || 0,
    dacForce: Number(cols[5]) || 0,
    col1: Number(cols[6]) || 0,
    col2: Number(cols[7]) || 0,
    col3: Number(cols[8]) || 0,
    col4: Number(cols[9]) || 0,
    col5: Number(cols[10]) || 0,
    col6: Number(cols[11]) || 0,
    loopCounter: Number(cols[12]) || 0,
    eventLabel,
    timestamp: timestampMs,
    elapsedSeconds: startTimeMs ? (timestampMs - startTimeMs) / 1000 : 0,
  };
}

function splitLines(text) {
  return text.split(/\r\n|\r|\n/);
}

function parseConfigTimeMs(dateStr) {
  const [datePart, timePart] = dateStr.trim().split(/\s+/);
  if (!datePart || !timePart) return null;
  const [month, day, year] = datePart.split("/");
  const [hours, minutes, secMs] = timePart.split(":");
  if (!month || !day || !year || hours === undefined || minutes === undefined) return null;
  const [seconds, ms] = (secMs || "0").split(".");
  const t = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
    ms ? Number(ms) : 0
  ).getTime();
  return Number.isFinite(t) ? t : null;
}

function parseDataConfigRowLine(line) {
  const cols = line.split("\t");
  if (cols.length < 4) return null;
  const c0 = (cols[0] || "").trim();
  if (/^starttime$/i.test(c0)) return null;
  const ts = parseConfigTimeMs(c0);
  if (ts === null) return null;
  const eventCounter = Number(cols[1]);
  if (!Number.isFinite(eventCounter)) return null;
  const eventName = String(cols[3] ?? "").trim() || `Event ${eventCounter}`;
  return { startTimeMs: ts, eventCounter, eventName };
}

app.post("/api/reset", (req, res) => {
  byteOffset = 0;
  lineCount = 0;
  headerParsed = false;
  startTimeMs = 0;
  headerLine = "";
  partialLine = "";
  dcByteOffset = 0;
  dcPartialLine = "";
  dcHeaderSkipped = false;
  dcLineCount = 0;
  res.json({ ok: true });
});

app.get("/api/poll", (req, res) => {
  if (!fs.existsSync(csvPath)) {
    return res.json({ error: "File not found", path: csvPath, rows: [], totalLines: 0 });
  }

  const stat = fs.statSync(csvPath);
  const fileSize = stat.size;

  if (fileSize < byteOffset) {
    byteOffset = 0;
    lineCount = 0;
    headerParsed = false;
    startTimeMs = 0;
    headerLine = "";
    partialLine = "";
  }

  if (fileSize === byteOffset && !partialLine) {
    return res.json({ rows: [], totalLines: lineCount, newLines: 0, fileSize, caught_up: true });
  }

  // Read up to MAX_CHUNK_BYTES of new data
  const available = fileSize - byteOffset;
  const readSize = Math.min(available, MAX_CHUNK_BYTES);

  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(csvPath, "r");
  fs.readSync(fd, buffer, 0, readSize, byteOffset);
  fs.closeSync(fd);

  byteOffset += readSize;

  // Prepend any leftover partial line from previous poll
  const rawChunk = partialLine + buffer.toString("utf-8");
  const lines = splitLines(rawChunk);

  // Last element may be incomplete if we didn't read to end-of-line
  // Keep it as partial for next poll
  if (byteOffset < fileSize) {
    partialLine = lines.pop() || "";
  } else {
    // We read to end of file - last line might be complete or empty
    const lastLine = lines[lines.length - 1];
    if (lastLine === "") {
      lines.pop();
      partialLine = "";
    } else {
      // File might still be mid-write; keep last line as partial
      partialLine = lines.pop() || "";
    }
  }

  let linesToProcess = lines;

  if (!headerParsed && linesToProcess.length > 0) {
    headerLine = linesToProcess[0];
    headerParsed = true;
    linesToProcess = linesToProcess.slice(1);
    lineCount = 1;

    if (linesToProcess.length > 0 && linesToProcess[0].trim()) {
      const firstCols = linesToProcess[0].split("\t");
      if (firstCols[0]) {
        startTimeMs = parseTimestamp(firstCols[0].trim());
      }
    }
  }

  const newRows = [];
  for (const line of linesToProcess) {
    if (!line.trim()) continue;
    const parsed = parseLine(line);
    if (parsed) {
      if (!startTimeMs) {
        startTimeMs = parseTimestamp(parsed.startTime);
        parsed.elapsedSeconds = (parsed.timestamp - startTimeMs) / 1000;
      }
      newRows.push(parsed);
    }
    lineCount++;
  }

  const caughtUp = byteOffset >= fileSize && !partialLine;

  res.json({
    rows: newRows,
    totalLines: lineCount,
    newLines: newRows.length,
    fileSize,
    byteOffset,
    caught_up: caughtUp,
  });
});

app.get("/api/data-config-csv/poll", (req, res) => {
  if (!fs.existsSync(dataConfigCsvPath)) {
    return res.json({
      error: "File not found",
      path: dataConfigCsvPath,
      rows: [],
      totalLines: 0,
    });
  }

  const stat = fs.statSync(dataConfigCsvPath);
  const fileSize = stat.size;

  if (fileSize < dcByteOffset) {
    dcByteOffset = 0;
    dcPartialLine = "";
    dcHeaderSkipped = false;
    dcLineCount = 0;
  }

  if (fileSize === dcByteOffset && !dcPartialLine) {
    return res.json({
      rows: [],
      totalLines: dcLineCount,
      newLines: 0,
      fileSize,
      caught_up: true,
      path: dataConfigCsvPath,
    });
  }

  const available = fileSize - dcByteOffset;
  const readSize = Math.min(available, MAX_CHUNK_BYTES);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(dataConfigCsvPath, "r");
  fs.readSync(fd, buffer, 0, readSize, dcByteOffset);
  fs.closeSync(fd);
  dcByteOffset += readSize;

  const rawChunk = dcPartialLine + buffer.toString("utf-8");
  const lines = splitLines(rawChunk);

  if (dcByteOffset < fileSize) {
    dcPartialLine = lines.pop() || "";
  } else {
    const lastLine = lines[lines.length - 1];
    if (lastLine === "") {
      lines.pop();
      dcPartialLine = "";
    } else {
      dcPartialLine = lines.pop() || "";
    }
  }

  let toProcess = lines;
  if (!dcHeaderSkipped && toProcess.length > 0) {
    const first = toProcess[0];
    const fc = (first.split("\t")[0] || "").trim();
    if (/^starttime$/i.test(fc)) {
      toProcess = toProcess.slice(1);
      dcLineCount = 1;
    }
    dcHeaderSkipped = true;
  }

  const newRows = [];
  for (const line of toProcess) {
    if (!line.trim()) continue;
    const parsed = parseDataConfigRowLine(line);
    if (parsed) newRows.push(parsed);
    dcLineCount++;
  }

  const caughtUp = dcByteOffset >= fileSize && !dcPartialLine;
  res.json({
    rows: newRows,
    totalLines: dcLineCount,
    newLines: newRows.length,
    fileSize,
    byteOffset: dcByteOffset,
    caught_up: caughtUp,
    path: dataConfigCsvPath,
  });
});

app.get("/api/status", (req, res) => {
  const exists = fs.existsSync(csvPath);
  let fileSize = 0;
  if (exists) {
    fileSize = fs.statSync(csvPath).size;
  }
  res.json({
    path: csvPath,
    exists,
    fileSize,
    byteOffset,
    lineCount,
    headerParsed,
    dataConfigCsvPath,
    dataConfigCsvExists: fs.existsSync(dataConfigCsvPath),
  });
});

const PORT = Number(
  process.env.DASHBOARD_API_PORT || process.env.PORT || 3001
);
app.listen(PORT, () => {
  console.log(`File watcher server running on http://localhost:${PORT}`);
  console.log(`Watching: ${csvPath}`);
  console.log(`DataConfig.csv: ${dataConfigCsvPath} (GET /api/data-config-csv/poll; set DATA_CONFIG_PATH to override)`);
  console.log(`Max chunk per poll: ${(MAX_CHUNK_BYTES / 1024).toFixed(0)} KB`);
});
