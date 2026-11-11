// Read existing records from Excel reports (Vyapar "Sale Report" / "Purchase Report"
// exports) and turn them into customers, vendors, products, invoices and payments.

const GST_STATES = { "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
  "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh",
  "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh" };

const n = (v) => { const x = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isNaN(x) ? 0 : x; };
const s = (v) => String(v ?? "").trim();
const toIso = (d) => { const m = s(d).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : ""; };
const fyOf = (iso) => { const [y, m] = iso.split("-").map(Number); return String((m >= 4 ? y : y - 1) % 100).padStart(2, "0"); };
const normName = (x) => s(x).toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
const cleanName = (x) => s(x).replace(/\s*\.+$/, "").replace(/\s+/g, " ");
const isBR = (x) => /^BR\d{4,}$/i.test(s(x));
const gstOf = (x) => { const m = s(x).match(/^([\d.,]+)\s*\(([\d.]+)%\)/); return m ? { amt: n(m[1]), rate: n(m[2]) } : { amt: 0, rate: null }; };
const mostCommon = (arr) => { const c = {}; let best = arr[0]; for (const a of arr) if (a) { c[a] = (c[a] || 0) + 1; if (c[a] > (c[best] || 0)) best = a; } return best || ""; };

function table(XLSX, ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
  const hi = rows.findIndex((r) => s(r[0]) === "Date");
  if (hi < 0) return [];
  const hd = rows[hi].map(s);
  return rows.slice(hi + 1).filter((r) => toIso(r[0])).map((r) => Object.fromEntries(hd.map((k, i) => [k || `c${i}`, s(r[i])])));
}

/** workbooks: [{ name, wb }] -> bundle for POST /api/admin/load, plus notes for the preview. */
export function readOldRecords(XLSX, workbooks) {
  let sales = [], saleItems = [], purch = [], purchItems = [];
  const found = [];
  for (const { name, wb } of workbooks) {
    for (const sh of wb.SheetNames) {
      const t = table(XLSX, wb.Sheets[sh]);
      if (!t.length) continue;
      const cols = Object.keys(t[0]);
      if (cols.includes("Invoice No.") && cols.includes("Received Amount")) { sales = sales.concat(t); found.push(`${name}: ${t.length} sales invoices`); }
      else if (cols.includes("Bill No.") && cols.includes("Paid Amount")) { purch = purch.concat(t); found.push(`${name}: ${t.length} purchase bills`); }
      else if (cols.includes("Item Name") && cols.includes("Invoice No.")) {
        if (/purchase/i.test(sh) || /purchase/i.test(name)) purchItems = purchItems.concat(t); else saleItems = saleItems.concat(t);
        found.push(`${name}: ${t.length} item lines (${sh})`);
      } else found.push(`${name} / ${sh}: not recognised, ignored`);
    }
  }
  sales = sales.filter((r) => !r["Transaction Type"] || /sale/i.test(r["Transaction Type"]));

  // ---- parties, one per GSTIN (a customer with plants in several states gets one record per plant)
  function parties(rows, prefix) {
    const groups = new Map();
    for (const r of rows) {
      const g = s(r["Party's GSTIN No."]).toUpperCase().replace(/\s/g, "");
      const key = g || normName(r["Party Name"]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const list = [...groups].map(([key, rs]) => {
      const gstin = s(rs[0]["Party's GSTIN No."]).toUpperCase().replace(/\s/g, "");
      return { key: prefix + key, name: cleanName(mostCommon(rs.map((r) => r["Party Name"]))), gstin, pan: gstin.length === 15 ? gstin.slice(2, 12) : "",
        phone: mostCommon(rs.map((r) => r["Phone No."])), state: GST_STATES[gstin.slice(0, 2)] || "", _norm: normName(rs[0]["Party Name"]).replace(/ PVT| PRIVATE| LTD| LIMITED/g, "") };
    });
    const count = {};
    for (const p of list) count[p._norm] = (count[p._norm] || 0) + 1;
    for (const p of list) { if (count[p._norm] > 1 && p.state) p.name = `${p.name} - ${p.state}`; delete p._norm; }
    return list;
  }
  const keyOf = (prefix, r) => prefix + (s(r["Party's GSTIN No."]).toUpperCase().replace(/\s/g, "") || normName(r["Party Name"]));
  const customers = parties(sales, "C:");
  const vendors = parties(purch, "V:");

  // ---- products
  const products = new Map();
  const saleKey = (r) => "S:" + (s(r["Item code"]) || normName(r["Item Name"]));
  for (const r of saleItems) {               // newest first in these reports
    const k = saleKey(r);
    const code = s(r["Item code"]), desc = s(r.Description);
    const drawing = isBR(code) ? code.toUpperCase() : (desc.match(/\bBR\d{4,}\b/i) || [""])[0].toUpperCase();
    const p = products.get(k) || { key: k, name: cleanName(r["Item Name"]), category: "FG", sellable: true, purchasable: false,
      customer_part_no: isBR(code) ? "" : code, drawing_no: drawing, description: "", uom: (s(r.Unit) || "NOS").toUpperCase(), _hsn: [], gst_rate: gstOf(r.GST).rate ?? 18, sale_rate: null };
    p._hsn.push(s(r["HSN/SAC"]));
    if (!p.drawing_no && drawing) p.drawing_no = drawing;
    if (!p.description && desc && !isBR(desc)) p.description = desc;
    if (p.sale_rate === null && n(r["Price/Unit"]) >= 1) p.sale_rate = n(r["Price/Unit"]);
    products.set(k, p);
  }
  const noStock = /fixture|assembly table|\btable\b|modification/i;
  const purchKey = (r) => "P:" + normName(r["Item Name"]);
  for (const r of purchItems) {
    const name = cleanName(r["Item Name"]), desc = s(r.Description);
    if (noStock.test(name + " " + desc)) continue;
    const k = purchKey(r);
    const unit = (s(r.Unit) || "NOS").toUpperCase();
    const cat = /tube|pipe|pa1[12]|pa6/i.test(name) && unit === "MTR" ? "RM" : /box|crate|carton|\bbin\b|scl /i.test(name + " " + desc) ? "PK" : "BO";
    const p = products.get(k) || { key: k, name, category: cat, sellable: false, purchasable: true, customer_part_no: "",
      drawing_no: isBR(desc) ? desc.toUpperCase() : "", description: isBR(desc) ? "" : desc, uom: unit, _hsn: [], gst_rate: gstOf(r.GST).rate ?? 18,
      purchase_rate: n(r["Price/Unit"]) || null, material: (name.match(/PA\s?1?\d/i) || [""])[0].toUpperCase().replace(/\s/g, "") };
    p._hsn.push(s(r["HSN/SAC"]));
    products.set(k, p);
  }
  for (const p of products.values()) { p.hsn = mostCommon(p._hsn.filter(Boolean)); delete p._hsn; }

  // ---- documents
  const linesBy = (items, noKey) => { const m = {}; for (const r of items) (m[`${normName(r["Party Name"])}|${s(r[noKey]).toUpperCase()}`] ||= []).push(r); return m; };
  const sl = linesBy(saleItems, "Invoice No.");
  const salesOut = sales.map((r) => {
    const date = toIso(r.Date);
    const raw = s(r["Invoice No."]);
    const m = raw.match(/^R?\s*\/?\s*(\d+)$/i);
    const invNo = m ? `R/${fyOf(date)}-${String(Number(m[1])).padStart(3, "0")}` : raw;
    const items = sl[`${normName(r["Party Name"])}|${raw.toUpperCase()}`] || [];
    return {
      inv_no: invNo, old_no: raw, date, party_key: keyOf("C:", r), po_no: s(r["Order No."]), total: n(r["Total Amount"]), received: n(r["Received Amount"]),
      balance: n(r["Balance Amount"]), tax: items.reduce((t, i) => t + gstOf(i.GST).amt, 0), gst_rate: items.length ? gstOf(items[0].GST).rate ?? 18 : 18,
      pay_mode: n(r["SBI NIGDI"]) > 0 ? "SBI NIGDI" : n(r.Cash) > 0 ? "Cash" : "",
      lines: items.slice().reverse().map((i) => {
        const code = s(i["Item code"]), desc = s(i.Description);
        return { product_key: saleKey(i), material_code: isBR(code) ? "" : code, part_no: isBR(code) ? code : (desc.match(/\bBR\d{4,}\b/i) || [""])[0],
          description: cleanName(i["Item Name"]), hsn: s(i["HSN/SAC"]), uom: s(i.Unit) || "NOS", qty: n(i.Quantity), rate: n(i["Price/Unit"]) };
      }),
    };
  });
  const pl = linesBy(purchItems, "Invoice No.");
  const purchOut = purch.map((r) => {
    const items = pl[`${normName(r["Party Name"])}|${s(r["Bill No."]).toUpperCase()}`] || [];
    return {
      doc_no: s(r["Bill No."]), date: toIso(r.Date), party_key: keyOf("V:", r), total: n(r["Total Amount"]), paid: n(r["Paid Amount"]), balance: n(r["Balance Amount"]),
      pay_mode: s(r["Payment Type"]),
      lines: items.slice().reverse().map((i) => {
        const name = cleanName(i["Item Name"]), desc = s(i.Description);
        return { product_key: noStock.test(name + " " + desc) ? "" : purchKey(i), part_no: isBR(desc) ? desc : "", description: desc && !isBR(desc) ? `${name} - ${desc}` : name,
          hsn: s(i["HSN/SAC"]), uom: s(i.Unit) || "NOS", qty: n(i.Quantity), rate: n(i["Price/Unit"]) };
      }),
    };
  });
  return { found, bundle: { customers, vendors, products: [...products.values()], sales: salesOut.reverse(), purchases: purchOut.reverse() } };
}
