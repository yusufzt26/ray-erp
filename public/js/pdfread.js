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

const UOMS = /^(nos?|pcs?|pc|mtrs?|mtr|m|kgs?|kg|sets?|ea|each|units?|rolls?|ltrs?|l|box|pair|prs?)\.?$/i;
const NUM_TOKEN = /^\d[\d,]*(?:\.\d+)?$/;

/** Fallback for text read from a picture: a row ending in "HSN qty UOM rate amount", where some
 *  of those may be missing or misread. Rate is worked out from amount / qty when they disagree. */
function linesFromLoose(lines) {
  const out = [];
  for (const line of lines) {
    const tok = line.trim().split(/\s+/);
    if (tok.length < 3) continue;
    const uomAt = tok.findIndex((t, i) => i > 0 && UOMS.test(t) && NUM_TOKEN.test(tok[i - 1]));
    let i = uomAt >= 0 ? uomAt - 1 : -1;
    let hsn = "";
    if (i < 0) { // no unit: need HSN followed by qty
      const hAt = tok.findIndex((t, k) => k > 0 && /^\d{4,8}$/.test(t) && NUM_TOKEN.test(tok[k + 1] || ""));
      if (hAt < 0) continue;
      hsn = tok[hAt]; i = hAt + 1;
    } else if (/^\d{4,8}$/.test(tok[i - 1] || "")) hsn = tok[i - 1];
    const qty = toNum(tok[i]);
    const after = tok.slice(uomAt >= 0 ? uomAt + 1 : i + 1).filter((t) => NUM_TOKEN.test(t)).map(toNum);
    let descTok = tok.slice(0, hsn ? i - 1 : i);
    if (descTok.length && (/^\d{1,3}[.)]?$/.test(descTok[0]) || /^[A-Za-z|]$/.test(descTok[0]) || /^[A-Z]{1,2}$/.test(descTok[0]) && descTok.length > 2)) descTok = descTok.slice(1);
    const desc = descTok.join(" ").trim();
    if (!qty || !/[A-Za-z]{2}/.test(desc) || after.length === 0) continue;
    let rate = after.length >= 2 ? after[after.length - 2] : after[0];
    let amount = after.length >= 2 ? after[after.length - 1] : null;
    if (amount !== null && rate && Math.abs(qty * rate - amount) > Math.max(1, amount * 0.02)) rate = Math.round((amount / qty) * 10000) / 10000;
    if (amount === null && rate) {
      // one number: rate if it is small next to qty x itself, otherwise it is the amount
      if (rate > 50 * qty && qty > 1) { amount = rate; rate = Math.round((amount / qty) * 10000) / 10000; } else amount = Math.round(qty * rate * 100) / 100;
    }
    let part = "";
    const first = desc.split(" ")[0];
    if (/[A-Za-z]/.test(first) && /\d/.test(first) && /^[A-Z0-9][A-Z0-9/._-]{3,}$/i.test(first) && desc.includes(" ")) part = first;
    out.push({ party_part_no: part, description: part ? desc.slice(part.length).trim() : desc, hsn, qty,
      uom: uomAt >= 0 ? tok[uomAt].replace(/\.$/, "").toUpperCase() : "", rate, amount });
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

/** Header fields and item lines from rows of cells (from a PDF, a spreadsheet or OCR). */
function analyse(allRows, firstPage, docType, ownGstin, ocr = false) {
  const lines = allRows.map((r) => r.text.replace(/\s{2,}/g, "  "));
  const flat = lines.map((l) => l.replace(/\s+/g, " "));
  const text = lines.join("\n");

  const gstins = [...new Set([...text.toUpperCase().matchAll(GSTIN_RE)].map((m) => m[1]))];
  const own = (ownGstin || "").toUpperCase().trim();
  const partyGstins = gstins.filter((g) => g !== own);

  let items = linesFromLayout(allRows);
  if (!items.length) items = linesFromText(flat);
  if (ocr) { const loose = linesFromLoose(flat); if (loose.length > items.length) items = loose; }
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

async function loadPdfjs(pdfjsLib) {
  const pdfjs = pdfjsLib || (await import("/vendor/pdf.min.mjs"));
  if (!pdfjsLib) pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  return pdfjs;
}

export async function readPdf(arrayBuffer, docType, ownGstin = "", pdfjsLib = null) {
  const pdfjs = await loadPdfjs(pdfjsLib);
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
  return analyse(allRows, firstPage, docType, ownGstin);
}

/** A spreadsheet (SheetJS workbook): every non-empty row becomes a row of cells placed by column. */
export function readSheet(XLSX, wb, docType, ownGstin = "") {
  const allRows = [];
  for (const name of wb.SheetNames.slice(0, 5)) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: false, blankrows: false });
    for (const r of aoa) {
      const cells = [];
      r.forEach((v, i) => { const t = String(v ?? "").replace(/\s+/g, " ").trim(); if (t) cells.push({ x: i * 100, x2: i * 100 + 90, text: t }); });
      if (cells.length) allRows.push({ cells, text: cells.map((c) => c.text).join("  ") });
    }
  }
  return analyse(allRows, allRows.slice(0, 10).map((r) => r.text), docType, ownGstin);
}

// ---------------------------------------------------------------- OCR (photos and scanned PDFs)
let tessWorker = null, ocrProgress = null;
function loadScript(src) {
  return new Promise((res, rej) => {
    const el = document.createElement("script");
    el.src = src; el.onload = res; el.onerror = () => rej(new Error("the text-recognition library did not load"));
    document.head.appendChild(el);
  });
}
async function ocrWorker() {
  if (!tessWorker) tessWorker = (async () => {
    if (!window.Tesseract) await loadScript("/vendor/tess/tesseract.min.js");
    return window.Tesseract.createWorker("eng", 1, {
      workerPath: "/vendor/tess/worker.min.js", corePath: "/vendor/tess", langPath: "/vendor/tess",
      logger: (m) => ocrProgress?.(m),
    });
  })();
  try { return await tessWorker; } catch (e) { tessWorker = null; throw e; }
}

const OCR_JUNK = /^[|\[\]{}()_=~—–\-.,:;'"!`]+$/;

const cleanWord = (x) => {
  const t = x.text.replace(/^[|\[\]]+|[|\[\]]+$/g, "").trim();
  if (!t || OCR_JUNK.test(t) || x.confidence < 10) return null;
  return t
    .replace(/^(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z])2([0-9A-Z])$/, "$1Z$2") // GSTIN: the 14th letter is always Z
    .replace(/^(\d{1,3})\.(\d{3}(?:\.\d{3})*)\.(\d{2})$/, (m, a, b, c) => `${a},${b.replace(/\./g, ",")}.${c}`); // 35.400.00 -> 35,400.00
};

/** Two readings of one image, laid out like PDF text:
 *  - "block": Tesseract reads the page as one block, so each printed row stays one line (good for straight scans);
 *  - "auto": Tesseract finds the layout itself and we rebuild the rows from word positions, corrected for tilt (good for photos). */
async function ocrRowSets(image) {
  const w = await ocrWorker();
  const sets = [];
  await w.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
  let { data } = await w.recognize(image, { rotateAuto: true });
  const block = [];
  (data.lines || []).forEach((line, li) => {
    for (const x of line.words || []) {
      const t = cleanWord(x);
      if (t) block.push({ str: t, width: x.bbox.x1 - x.bbox.x0, transform: [1, 0, 0, x.bbox.y1 - x.bbox.y0, x.bbox.x0, -li * 100000] });
    }
  });
  sets.push(itemsToRows(block));

  await w.setParameters({ tessedit_pageseg_mode: "3" });
  ({ data } = await w.recognize(image, { rotateAuto: true }));
  const slopes = (data.lines || []).map((l) => l.baseline).filter((bl) => bl && bl.x1 - bl.x0 > 80)
    .map((bl) => (bl.y1 - bl.y0) / (bl.x1 - bl.x0)).sort((a, b) => a - b);
  const slope = slopes.length ? slopes[slopes.length >> 1] : 0;
  const auto = [];
  for (const x of data.words || []) {
    const t = cleanWord(x);
    if (!t) continue;
    const xc = (x.bbox.x0 + x.bbox.x1) / 2, yc = (x.bbox.y0 + x.bbox.y1) / 2 - slope * xc;
    auto.push({ str: t, width: x.bbox.x1 - x.bbox.x0, transform: [1, 0, 0, x.bbox.y1 - x.bbox.y0, x.bbox.x0, -yc] });
  }
  sets.push(itemsToRows(auto));
  return sets;
}

/** The reading that found more: item lines count most, then the header fields. */
function bestReading(results) {
  const score = (r) => r.lines.length * 4 + !!r.doc_no + !!r.doc_date + !!r.total_amount + !!r.party_gstin
    + r.lines.filter((l) => l.amount && l.rate && Math.abs(l.qty * l.rate - l.amount) < 1).length;
  return results.reduce((a, b) => (score(b) > score(a) ? b : a));
}

/** Common misreads in order numbers ("PQ" for "PO", a letter O among digits). */
function fixOcr(r) {
  const doc_no = (r.doc_no || "").replace(/\bPQ\b/g, "PO").replace(/(?<=\d)[Oo](?=\d)/g, "0");
  const lines = r.lines.map((l) => ({ ...l, description: l.description.replace(/^[A-Za-z|]\s+(?=\S{3})/, "") }));
  return { ...r, doc_no, lines, ocr: true };
}

/** Draw an image file on a canvas, scaled so the longer side is about 2400 px (good for OCR, small to store). */
export async function imageToCanvas(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(2, 2400 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv;
}

/** Black-and-white copy with a local (adaptive) threshold: evens out shadows and uneven light in phone photos. */
function binarize(src) {
  const W = src.width, H = src.height;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  const g = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  const I = new Float64Array((W + 1) * (H + 1)); // integral image
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += g[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; }
  }
  const r = Math.max(8, Math.round(Math.max(W, H) / 60));
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const v = g[y * W + x] < mean * 0.85 ? 0 : 255;
      const k = (y * W + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

export async function readImage(canvas, docType, ownGstin = "", onProgress = null) {
  ocrProgress = onProgress;
  let sets = await ocrRowSets(canvas);
  const first = bestReading(sets.map((rows) => analyse(rows, [], docType, ownGstin, true)));
  if (first.lines.length < 2 || !first.doc_no) sets = sets.concat(await ocrRowSets(binarize(canvas))); // try again on a cleaned-up copy
  return fixOcr(bestReading(sets.map((rows) => analyse(rows, rows.slice(0, 10).map((x) => x.text), docType, ownGstin, true))));
}

/** A PDF with no text inside (a scan): render each page and OCR it. */
export async function readScannedPdf(arrayBuffer, docType, ownGstin = "", onProgress = null) {
  const pdfjs = await loadPdfjs(null);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) }).promise;
  const allRows = [];
  let firstPage = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 5); n++) {
    const page = await pdf.getPage(n);
    const vp0 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, 2400 / Math.max(vp0.width, vp0.height)) });
    const cv = document.createElement("canvas");
    cv.width = viewport.width; cv.height = viewport.height;
    await page.render({ canvasContext: cv.getContext("2d"), viewport }).promise;
    ocrProgress = (m) => onProgress?.({ ...m, page: n, pages: Math.min(pdf.numPages, 5) });
    const sets = await ocrRowSets(cv);
    const pick = sets.indexOf(sets.reduce((a, b) => (b.length && analyse(b, [], docType, ownGstin, true).lines.length > analyse(a, [], docType, ownGstin, true).lines.length ? b : a)));
    const rows = sets[pick];
    if (n === 1) firstPage = rows.slice(0, 10).map((r) => r.text);
    allRows.push(...rows);
  }
  return fixOcr(analyse(allRows, firstPage, docType, ownGstin, true));
}

export const _test = { parseDate, linesFromText, linesFromLoose, mapHeader, itemsToRows, linesFromLayout };
