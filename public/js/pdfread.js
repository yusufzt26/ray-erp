// Reads a customer PO or vendor invoice PDF in the browser and guesses the
// header fields and item lines. Everything is shown in an editable form before
// saving, so this aims for "mostly right", not perfect.

const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;
const NUM = String.raw`[-+]?\d[\d,]*(?:\.\d+)?`;

const DOC_NO_LABELS = {
  customer_po: [String.raw`purchase\s*order\s*(?:no|number|#)`, String.raw`p\.?\s*o\.?\s*(?:no|number|#)`,
    String.raw`order\s*(?:no|number|#)`, String.raw`sch(?:edule)?\s*(?:agreement\s*)?no`],
  vendor_invoice: [String.raw`tax\s*invoice\s*(?:no|number|#)`, String.raw`invoice\s*(?:no|number|#)`,
    String.raw`inv\.?\s*(?:no|number|#)`, String.raw`bill\s*(?:no|number|#)`, String.raw`document\s*no`],
};
const DATE_LABELS = {
  customer_po: [String.raw`p\.?\s*o\.?\s*date`, String.raw`order\s*date`, String.raw`purchase\s*order\s*date`, "date"],
  vendor_invoice: [String.raw`invoice\s*date`, String.raw`inv\.?\s*date`, String.raw`bill\s*date`, "date"],
};
const TOTAL_LABELS = [String.raw`grand\s*total`, String.raw`total\s*invoice\s*(?:value|amount)`, String.raw`invoice\s*(?:value|total)`,
  String.raw`net\s*(?:amount|value|payable)`, String.raw`total\s*(?:po\s*)?(?:amount|value)`, String.raw`amount\s*payable`, "total"];

const COLUMN_KEYS = {
  party_part_no: ["part no", "part number", "item code", "material code", "mat code", "part code", "material no", "item no", "code"],
  description: ["description", "particulars", "item description", "material description", "product", "item name", "material", "goods", "item", "name"],
  hsn: ["hsn", "sac"],
  qty: ["qty", "quantity", "qnty", "order qty", "nos"],
  uom: ["uom", "unit", "u.o.m", "per"],
  rate: ["rate", "unit price", "price", "basic rate", "unit rate"],
  amount: ["amount", "value", "total", "net amount", "taxable value", "basic amount", "line total"],
};

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export function toNum(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/,/g, "").replace(/₹|Rs\.?|INR/g, "").match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function ymd(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCMonth() !== m || dt.getUTCDate() !== d || y < 2000 || y > 2100) return null;
  return dt.toISOString().slice(0, 10);
}

/** 05/11/2026, 05-11-26, 2026-11-05, 8-Nov-2026, 8th November 2026, Nov 8, 2026. Numbers are day-first. */
export function parseDate(s) {
  if (!s) return null;
  let m;
  if ((m = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/))) { const r = ymd(+m[3], +m[2] - 1, +m[1]); if (r) return r; }
  if ((m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) { const r = ymd(+m[1], +m[2] - 1, +m[3]); if (r) return r; }
  if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?[ ./,-]*([A-Za-z]{3,9})[ ./,-]*(\d{2,4})\b/))) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith("sept") ? 4 : 3)];
    if (mo !== undefined) { const r = ymd(+m[3], mo, +m[1]); if (r) return r; }
  }
  if ((m = s.match(/\b([A-Za-z]{3,9})[ ./,-]*(\d{1,2})[ ./,-]+(\d{4})\b/))) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mo !== undefined) { const r = ymd(+m[3], mo, +m[2]); if (r) return r; }
  }
  if ((m = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2})\b/))) { const r = ymd(+m[3], +m[2] - 1, +m[1]); if (r) return r; }
  return null;
}

function valueAfterLabel(lines, labels) {
  const val = String.raw`[A-Za-z0-9][A-Za-z0-9/\-_.]*`;
  for (const lab of labels) {
    const rx = new RegExp(String.raw`\b${lab}\.?\s*[:.\-#]*\s*(${val})`, "i");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(rx);
      if (!m) continue;
      const v = m[1].replace(/^[ .:-]+|[ .:-]+$/g, "");
      if (v && !["date", "dt", "dated", "no", "number"].includes(v.toLowerCase()) && /\d/.test(v)) return v;
      const next = lines[i + 1]?.match(new RegExp(String.raw`^\s*(${val})`));
      if (next && /\d/.test(next[1])) return next[1];
    }
  }
  return null;
}

function dateAfterLabel(lines, labels, fallback = true) {
  for (const lab of labels) {
    const rx = new RegExp(String.raw`\b${lab}\b\.?\s*[:.\-]*\s*(.{0,30})`, "gi");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(rx)) {
        const d = parseDate(m[1]) || parseDate((lines[i + 1] || "").slice(0, 30));
        if (d) return d;
      }
    }
  }
  return fallback ? parseDate(lines.join("\n")) : null;
}

function amountAfterLabel(text, labels) {
  for (const lab of labels) {
    const rx = new RegExp(String.raw`\b${lab}\b[^\d\n]{0,40}(${NUM})`, "gi");
    const found = [...text.matchAll(rx)].map((m) => toNum(m[1])).filter((n) => n && n > 0);
    if (found.length) return Math.max(...found);
  }
  return null;
}

function mapHeader(cells) {
  const mapping = {};
  const used = new Set();
  const low = cells.map(norm);
  for (const [field, keys] of Object.entries(COLUMN_KEYS)) {
    let best = null;
    low.forEach((cell, idx) => {
      if (!cell || used.has(idx)) return;
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (cell === key || cell.startsWith(key) || new RegExp(String.raw`\b${esc(key)}\b`).test(cell)) {
          if (!best || k < best[0]) best = [k, idx];
          break;
        }
      }
    });
    if (best) { mapping[field] = best[1]; used.add(best[1]); }
  }
  return "qty" in mapping && ("description" in mapping || "party_part_no" in mapping) ? mapping : null;
}

function rowToLine(get) {
  const qty = toNum(get("qty"));
  const desc = (get("description") || "").replace(/\s+/g, " ").trim();
  const part = (get("party_part_no") || "").replace(/\s+/g, " ").trim();
  if (!qty || (!desc && !part)) return null;
  let rate = toNum(get("rate"));
  let amount = toNum(get("amount"));
  if (amount === null && rate !== null) amount = Math.round(qty * rate * 100) / 100;
  if (rate === null && amount) rate = Math.round((amount / qty) * 10000) / 10000;
  return { party_part_no: part, description: desc, hsn: (get("hsn") || "").trim(), qty, uom: (get("uom") || "").trim().toUpperCase(), rate, amount };
}

/** Table rows found by x-position: header cells set the columns, later rows are split at the midpoints. */
function linesFromLayout(rows) {
  const out = [];
  let header = null; // { map, bounds }
  for (const row of rows) {
    const cells = row.cells;
    if (!header) {
      const map = mapHeader(cells.map((c) => c.text));
      if (map) {
        const centers = cells.map((c) => (c.x + c.x2) / 2);
        const bounds = centers.map((c, i) => (i === 0 ? -Infinity : (centers[i - 1] + c) / 2));
        header = { map, bounds, n: cells.length };
      }
      continue;
    }
    const cols = new Array(header.n).fill("");
    for (const c of cells) {
      const center = (c.x + c.x2) / 2;
      let idx = 0;
      for (let i = 0; i < header.bounds.length; i++) if (center >= header.bounds[i]) idx = i;
      // right-aligned numbers: snap by right edge when the centre lands in a text column
      cols[idx] = cols[idx] ? cols[idx] + " " + c.text : c.text;
    }
    const line = rowToLine((f) => (f in header.map ? cols[header.map[f]] : null));
    if (line) out.push(line);
    else if (/\b(grand total|total invoice|amount in words|terms)\b/i.test(row.text)) header = null;
  }
  return out;
}

const LINE_TEXT_RE = new RegExp(String.raw`^\s*(?:\d{1,3}[.)]?\s+)?(.+?)\s+(${NUM})\s*([A-Za-z]{2,4})?\s+(${NUM})\s+(${NUM})\s*$`);

/** Fallback: 'description qty rate amount' rows where qty x rate is close to amount. */
function linesFromText(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(LINE_TEXT_RE);
    if (!m) continue;
    const qty = toNum(m[2]), rate = toNum(m[4]), amount = toNum(m[5]);
    if (!qty || !rate || !amount || Math.abs(qty * rate - amount) > Math.max(1, amount * 0.02)) continue;
    let desc = m[1].trim(), hsn = "";
    const h = desc.match(/\b(\d{4,8})\s*$/);
    if (h) { hsn = h[1]; desc = desc.slice(0, h.index).trim(); }
    out.push({ party_part_no: "", description: desc, hsn, qty, uom: (m[3] || "").toUpperCase(), rate, amount });
  }
  return out;
}

const SKIP_TITLE = /^(tax\s*invoice|invoice|purchase\s*order|p\.?o\.?|original|duplicate|triplicate|copy|for recipient|for transporter|page|e-?invoice|bill of supply|sales order|gstin|irn|ack)\b/i;

function guessIssuer(firstPageLines) {
  for (const raw of firstPageLines.slice(0, 8)) {
    const s = raw.trim();
    const digits = (s.match(/\d/g) || []).length;
    if (s.length < 4 || SKIP_TITLE.test(s) || new RegExp(GSTIN_RE.source).test(s.toUpperCase()) || digits > s.length / 3) continue;
    return s.replace(/\s{2,}.*$/, "").slice(0, 120);
  }
  return "";
}

/** Turn pdf.js text items into rows of cells (sorted top-to-bottom, left-to-right). */
function itemsToRows(items) {
  const parts = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => ({ x: it.transform[4], y: it.transform[5], x2: it.transform[4] + (it.width || 0), h: Math.abs(it.transform[3]) || 8, str: it.str }));
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const p of parts) {
    const row = rows.find((r) => Math.abs(r.y - p.y) <= Math.max(2.5, p.h * 0.35));
    if (row) row.parts.push(p); else rows.push({ y: p.y, parts: [p] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    const cells = [];
    for (const p of r.parts) {
      const last = cells[cells.length - 1];
      const gap = last ? p.x - last.x2 : Infinity;
      if (last && gap < p.h * 0.9) {
        last.text += (gap > p.h * 0.15 ? " " : "") + p.str.trim();
        last.x2 = Math.max(last.x2, p.x2);
      } else cells.push({ x: p.x, x2: p.x2, text: p.str.trim() });
    }
    return { cells, text: cells.map((c) => c.text).join("  ") };
  });
}

export async function readPdf(arrayBuffer, docType, ownGstin = "", pdfjsLib = null) {
  const pdfjs = pdfjsLib || (await import("/vendor/pdf.min.mjs"));
  if (!pdfjsLib) pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) }).promise;
  const allRows = [];
  let firstPage = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 20); n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const rows = itemsToRows(content.items);
    if (n === 1) firstPage = rows.map((r) => r.text);
    allRows.push(...rows);
  }
  const lines = allRows.map((r) => r.text.replace(/\s{2,}/g, "  "));
  const flat = lines.map((l) => l.replace(/\s+/g, " "));
  const text = lines.join("\n");

  const gstins = [...new Set([...text.toUpperCase().matchAll(GSTIN_RE)].map((m) => m[1]))];
  const own = (ownGstin || "").toUpperCase().trim();
  const partyGstins = gstins.filter((g) => g !== own);

  let items = linesFromLayout(allRows);
  if (!items.length) items = linesFromText(flat);
  const hasDelivery = /delivery\s*date|due\s*date|required\s*by|schedule\s*date/i.test(text);

  return {
    doc_no: valueAfterLabel(flat, DOC_NO_LABELS[docType]),
    doc_date: dateAfterLabel(flat, DATE_LABELS[docType]),
    delivery_date: docType === "customer_po" && hasDelivery
      ? dateAfterLabel(flat, [String.raw`delivery\s*date`, String.raw`due\s*date`, String.raw`required\s*by`, String.raw`schedule\s*date`], false) : null,
    party_gstin: partyGstins[0] || "",
    party_name: guessIssuer(firstPage),
    all_gstins: gstins,
    total_amount: amountAfterLabel(flat.join("\n"), TOTAL_LABELS),
    lines: items,
    text,
    scanned: text.replace(/\s/g, "").length < 20,
  };
}

export const _test = { parseDate, linesFromText, mapHeader, itemsToRows, linesFromLayout };
