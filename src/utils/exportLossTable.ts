// Minimal OOXML writer for this table; exports real .xlsx files without a server.
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const columnName = (n: number): string => {
  let result = "";
  for (n++; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
};
const rgb = (value: string, fallback: string): string => {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return match ? match.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase() : fallback;
};

function zip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [], directory: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path), data = encoder.encode(content);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true);
    l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.set(name, 46);
    chunks.push(local, data); directory.push(central); offset += local.length + data.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, directory.length, true); e.setUint16(10, directory.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const output = new Uint8Array(offset + size + end.length);
  let position = 0;
  for (const part of [...chunks, ...directory, end]) { output.set(part, position); position += part.length; }
  return output;
}

export function buildLossWorkbook(table: HTMLTableElement): Uint8Array {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const occupied = new Set<string>(), merges: string[] = [], styles: string[] = [], fills: string[] = [], fonts: string[] = [];
  const styleIds = new Map<string, number>();
  let maxColumns = 0;
  function style(bg: string, fg: string, header: boolean, format: number): number {
    const key = [bg, fg, header, format].join(":");
    const old = styleIds.get(key); if (old !== undefined) return old;
    const id = styles.length; styleIds.set(key, id);
    fonts.push(`<font><sz val="11"/><color rgb="FF${fg}"/><name val="Calibri"/>${header ? "<b/>" : ""}</font>`);
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${bg}"/><bgColor indexed="64"/></patternFill></fill>`);
    styles.push(`<xf numFmtId="${format}" fontId="${id}" fillId="${id + 2}" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="${header ? "center" : format ? "right" : "left"}"/></xf>`);
    return id;
  }
  style("FFFFFF", "000000", false, 0);
  const rows = Array.from(table.rows).map((row, ri) => {
    let ci = 0;
    const cells: string[] = [];
    for (const cell of Array.from(row.cells)) {
      while (occupied.has(`${ri}:${ci}`)) ci++;
      const ref = `${columnName(ci)}${ri + 1}`;
      const text = cell.textContent?.trim() || "";
      const numeric = /^-?\d+(\.\d+)?$/.test(text);
      const computed = getComputedStyle(cell);
      const format = numeric ? (cell.style.backgroundColor ? 165 : 164) : 0;
      const sid = style(rgb(computed.backgroundColor, "FFFFFF"), rgb(computed.color, "000000"), cell.tagName === "TH", format);
      cells.push(numeric ? `<c r="${ref}" s="${sid}"><v>${Number(text)}</v></c>` : `<c r="${ref}" s="${sid}" t="inlineStr"><is><t>${xml(text)}</t></is></c>`);
      for (let r = ri; r < ri + cell.rowSpan; r++) for (let c = ci; c < ci + cell.colSpan; c++) {
        occupied.add(`${r}:${c}`);
        if (r === ri && c !== ci) cells.push(`<c r="${columnName(c)}${r + 1}" s="${sid}"/>`);
      }
      if (cell.rowSpan > 1 || cell.colSpan > 1) merges.push(`<mergeCell ref="${ref}:${columnName(ci + cell.colSpan - 1)}${ri + cell.rowSpan}"/>`);
      ci += cell.colSpan; maxColumns = Math.max(maxColumns, ci);
    }
    return `<row r="${ri + 1}" ht="22" customHeight="1">${cells.join("")}</row>`;
  });
  const sheet = `<worksheet ${ns}><sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="2" topLeftCell="C3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${maxColumns}" width="17" customWidth="1"/></cols><sheetData>${rows.join("")}</sheetData><mergeCells count="${merges.length}">${merges.join("")}</mergeCells></worksheet>`;
  const borders = '<border><left style="thin"><color rgb="FF94A3B8"/></left><right style="thin"><color rgb="FF94A3B8"/></right><top style="thin"><color rgb="FF94A3B8"/></top><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border>';
  return zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Loss per Event" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/styles.xml': `<styleSheet ${ns}><numFmts count="2"><numFmt numFmtId="164" formatCode="0.000000"/><numFmt numFmtId="165" formatCode="0.0000"/></numFmts><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills.join("")}</fills><borders count="2"><border/><border>${borders.slice(8, -9)}</border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${styles.length}">${styles.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  });
}

export function downloadLossTable(table: HTMLTableElement): void {
  const bytes = buildLossWorkbook(table);
  const blob = new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = "loss-per-event.xlsx";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
