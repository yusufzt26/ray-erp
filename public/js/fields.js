// Shared by the browser app and the API function. One definition drives the
// list pages, add/edit forms, Excel/CSV templates, import and export.

export const ROLES = ["Admin", "Purchaser", "Sales", "Store", "Production", "Accounts"];
export const LEVELS = ["none", "view", "edit"];
export const MODULES = {
  customers: "Customers",
  vendors: "Vendors",
  products: "Products",
  quotation: "Quotations",
  customer_po: "Sales Orders (Customer POs)",
  delivery_challan: "Delivery Challans",
  sales_invoice: "Sales Invoices & Sales Register",
  stock: "Stock",
  production: "Production Plan",
  accounts: "Accounts (receivable / payable)",
  purchase_order: "Purchase Orders",
  grn: "Goods Receipts (GRN)",
  vendor_invoice: "Vendor Invoices",
  users: "Users & Roles",
};

/** Type of a document: regular production, new product development, or an expense (not for production). */
export const SEGMENTS = [["Regular", "Regular production"], ["NPD", "NPD (new product development)"], ["Expense", "Expenses"]];
export const segmentPill = (seg) => (seg === "NPD" ? ' <span class="pill npd">NPD</span>' : seg === "Expense" ? ' <span class="pill exp">Expense</span>' : "");
export const segmentFilter = (seg) => `<select name="segment" onchange="this.form.requestSubmit()"><option value="">All types</option>${SEGMENTS.map(([v, l]) => `<option value="${v}" ${seg === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
export const segmentChoice = (cur) => `<select name="segment">${SEGMENTS.map(([v, l]) => `<option value="${v}" ${(cur || "Regular") === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;

/** Date filter on document lists. "year" is the financial year (April to March). */
export const PERIODS = [["", "All dates"], ["today", "Today"], ["week", "This week"], ["month", "This month"], ["lastmonth", "Last month"], ["year", "This financial year"], ["custom", "Custom: from … to …"]];
const dateOnly = (v) => String(v ?? "").replace(/[^0-9-]/g, "");
/** Date filter for lists; "Custom" shows From and To dates. */
export const periodFilter = (per, from = "", to = "") => `<select name="period" title="Show by date"
    onchange="var c=this.value==='custom';this.form.querySelectorAll('.prange').forEach(function(x){x.hidden=!c});if(!c)this.form.requestSubmit()">
    ${PERIODS.map(([v, l]) => `<option value="${v}" ${(per || "") === v ? "selected" : ""}>${l}</option>`).join("")}</select>
  <label class="prange" ${per === "custom" ? "" : "hidden"}>From <input type="date" name="from" value="${dateOnly(from)}"></label>
  <label class="prange" ${per === "custom" ? "" : "hidden"}>To <input type="date" name="to" value="${dateOnly(to)}" onchange="this.form.requestSubmit()"></label>`;

export const BUILTIN_CATEGORIES = ["FG", "SA", "CP", "RM", "BO", "CN", "PK", "SV"];
export const PRODUCT_CATEGORIES = {
  FG: "Finished Good (pipe / assembly)",
  SA: "Sub-Assembly",
  CP: "Child Part",
  RM: "Raw Material",
  BO: "Bought-Out Item",
  CN: "Consumable",
  PK: "Packing Material",
  SV: "Service (no stock)",
};
/** Categories that are never counted in stock (services such as job work, testing, tooling, transport). */
export const NON_STOCK = ["SV"];

export const INDIAN_STATES = ["", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa",
  "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra",
  "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
  "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands",
  "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh",
  "Lakshadweep", "Puducherry"];

const F = (key, label, opts = {}) => ({ key, label, type: "text", required: false, inList: false, help: "", ...opts });

const PARTY_FIELDS = [
  F("name", "Name", { required: true, inList: true }),
  F("gstin", "GSTIN", { inList: true, help: "15 characters, used to match uploaded PDFs" }),
  F("pan", "PAN"),
  F("contact_person", "Contact Person", { inList: true }),
  F("phone", "Phone", { inList: true }),
  F("email", "Email"),
  F("address", "Address", { type: "textarea", help: "Printed as Bill To on invoices (add Kind Attn on the last line)" }),
  F("city", "City", { inList: true }),
  F("state", "State", { type: "select", options: INDIAN_STATES.map((s) => [s, s || "—"]) }),
  F("pincode", "Pincode"),
  F("payment_terms", "Payment Terms", { help: "e.g. 30 days" }),
  F("notes", "Notes", { type: "textarea" }),
  F("active", "Active", { type: "check" }),
];

const CUSTOMER_FIELDS = [
  ...PARTY_FIELDS.slice(0, -2),
  F("supplier_code", "Our Supplier Code", { help: "The code this customer gives us; printed on invoices" }),
  F("ship_to", "Ship To Address", { type: "textarea", help: "Leave empty if same as the address" }),
  F("delivery_condition", "Delivery Condition", { help: "e.g. FOB Freeonboard" }),
  F("distance_km", "Distance (km)", { type: "number", help: "Road distance from our factory, used on e-way bills" }),
  ...PARTY_FIELDS.slice(-2),
];

const PRODUCT_FIELDS = [
  F("name", "Product Name", { required: true, inList: true }),
  F("category", "Category", {
    type: "select", required: true, inList: true,
    options: Object.entries(PRODUCT_CATEGORIES).map(([k, v]) => [k, `${k} - ${v}`]),
    help: "Decides the item code prefix, e.g. FG-00001",
  }),
  F("sellable", "Sellable", { type: "check", inList: true }),
  F("purchasable", "Purchasable", { type: "check", inList: true }),
  F("customer_part_no", "Customer Material Code / Part No", { inList: true, help: "The customer's code, e.g. 40007073. Used to match POs and printed on invoices" }),
  F("drawing_no", "Our Part / Drawing No", { help: "e.g. BR20658. Printed on box labels" }),
  F("material", "Material", { help: "e.g. PA12, PA11, PA6" }),
  F("description", "Description", { type: "textarea" }),
  F("uom", "Unit (UOM)", { type: "select", inList: true, options: ["NOS", "SET", "KG", "MTR", "LTR", "BOX", "PCS", "ROLL", "JOB", "HRS", "LOT"].map((u) => [u, u]) }),
  F("hsn", "HSN / SAC Code", { help: "SAC code for a service, e.g. 998898 job work, 998346 design" }),
  F("gst_rate", "GST %", { type: "number" }),
  F("sale_rate", "Sale Rate", { type: "number" }),
  F("purchase_rate", "Purchase Rate", { type: "number" }),
  F("notes", "Notes", { type: "textarea" }),
  F("active", "Active", { type: "check" }),
];

export const MASTERS = {
  customers: { title: "Customers", singular: "Customer", table: "customers", fields: CUSTOMER_FIELDS, prefix: "CUS", counter: "customer", icon: "👥" },
  vendors: { title: "Vendors", singular: "Vendor", table: "vendors", fields: PARTY_FIELDS, prefix: "VEN", counter: "vendor", icon: "🏭" },
  products: { title: "Products", singular: "Product", table: "products", fields: PRODUCT_FIELDS, prefix: null, counter: null, icon: "📦" },
};

// side: which menu group. own: we give the number (doc_no = our ref). pdf: can be read from an uploaded PDF.
export const DOC_TYPES = {
  quotation: {
    title: "Quotations", singular: "Quotation", partyTable: "customers", partyLabel: "Customer", partyMaster: "customers",
    prefix: "QTN", noLabel: "Quotation No", dateLabel: "Quotation Date", productFlag: "sellable",
    statuses: ["Draft", "Sent", "Accepted", "Lost"], icon: "📝", side: "sales", own: true, printTitle: "QUOTATION",
  },
  customer_po: {
    title: "Sales Orders", singular: "Sales Order", partyTable: "customers", partyLabel: "Customer",
    partyMaster: "customers", prefix: "CPO", noLabel: "Customer PO No", dateLabel: "PO Date",
    productFlag: "sellable", statuses: ["Open", "Partly Dispatched", "Completed", "Cancelled"], icon: "📥", side: "sales", pdf: true, printTitle: "SALES ORDER ACKNOWLEDGEMENT",
  },
  delivery_challan: {
    title: "Delivery Challans", singular: "Delivery Challan", partyTable: "customers", partyLabel: "Customer", partyMaster: "customers",
    prefix: "DC", noLabel: "Challan No", dateLabel: "Challan Date", productFlag: "sellable",
    statuses: ["Open", "Invoiced", "Cancelled"], icon: "🚚", side: "sales", own: true, printTitle: "DELIVERY CHALLAN",
  },
  purchase_order: {
    title: "Purchase Orders", singular: "Purchase Order", partyTable: "vendors", partyLabel: "Vendor", partyMaster: "vendors",
    prefix: "PO", noLabel: "PO No", dateLabel: "PO Date", productFlag: "purchasable",
    statuses: ["Open", "Partly Received", "Received", "Cancelled"], icon: "🛒", side: "purchase", own: true, printTitle: "PURCHASE ORDER",
  },
  grn: {
    title: "Goods Receipts (GRN)", singular: "Goods Receipt", partyTable: "vendors", partyLabel: "Vendor", partyMaster: "vendors",
    prefix: "GRN", noLabel: "GRN No", dateLabel: "Received Date", productFlag: "purchasable",
    statuses: ["Received", "Billed", "Cancelled"], icon: "📦", side: "purchase", own: true, printTitle: "GOODS RECEIPT NOTE",
  },
  vendor_invoice: {
    title: "Vendor Invoices", singular: "Vendor Invoice", partyTable: "vendors", partyLabel: "Vendor",
    partyMaster: "vendors", prefix: "VIN", noLabel: "Invoice No", dateLabel: "Invoice Date",
    productFlag: "purchasable", statuses: ["Received", "Checked", "Paid", "Cancelled"], icon: "🧾", side: "purchase", pdf: true,
  },
};

/** What each document can be turned into with one click. */
export const CONVERT = {
  quotation: ["customer_po"],
  customer_po: ["delivery_challan", "invoice"],
  delivery_challan: ["invoice"],
  purchase_order: ["grn", "vendor_invoice"],
  grn: ["vendor_invoice"],
};

/** Turn a form / Excel / CSV value into what the database stores. Throws Error with a readable message. */
export function coerce(field, raw) {
  const t = field.type;
  if (t === "check") {
    if (typeof raw === "boolean") return raw ? 1 : 0;
    if (typeof raw === "number") return raw ? 1 : 0;
    const s = String(raw ?? "").trim().toLowerCase();
    return ["1", "y", "yes", "true", "on", "x", "✓"].includes(s) ? 1 : 0;
  }
  if (raw === null || raw === undefined) return null;
  if (t === "number") {
    const s = String(raw).replace(/,/g, "").trim();
    if (s === "") return null;
    const n = Number(s);
    if (Number.isNaN(n)) throw new Error(`${field.label}: '${raw}' is not a number`);
    return n;
  }
  let s = String(raw).trim();
  if (field.key === "gstin" || field.key === "pan") s = s.toUpperCase().replace(/\s/g, "");
  if (field.key === "category") {
    s = s ? s.toUpperCase().split(/[\s\-–(]/)[0] : "FG";
    if (!PRODUCT_CATEGORIES[s]) throw new Error(`Category '${raw}' is not one of ${Object.keys(PRODUCT_CATEGORIES).join(", ")}`);
  }
  if (field.key === "uom" && s) s = s.toUpperCase();
  return s || null;
}

/** Add categories created by users (from the database) to the list used everywhere. */
export function addCategories(rows) {
  for (const r of rows || []) if (r.code && !BUILTIN_CATEGORIES.includes(r.code)) PRODUCT_CATEGORIES[r.code] = r.name;
  const f = MASTERS.products.fields.find((x) => x.key === "category");
  f.options = Object.entries(PRODUCT_CATEGORIES).map(([k, v]) => [k, `${k} - ${v}`]);
}

// ---------------------------------------------------------------- GST
// Same state as us: CGST + SGST (half the rate each). Other state: IGST (full rate).
// The state is the first two digits of the GSTIN; without a GSTIN, the party's State from the master.
export const GST_STATE_CODES = {
  "jammu and kashmir": 1, "himachal pradesh": 2, punjab: 3, chandigarh: 4, uttarakhand: 5, haryana: 6, delhi: 7, rajasthan: 8,
  "uttar pradesh": 9, bihar: 10, sikkim: 11, "arunachal pradesh": 12, nagaland: 13, manipur: 14, mizoram: 15, tripura: 16,
  meghalaya: 17, assam: 18, "west bengal": 19, jharkhand: 20, odisha: 21, chhattisgarh: 22, "madhya pradesh": 23, gujarat: 24,
  "dadra and nagar haveli and daman and diu": 26, maharashtra: 27, karnataka: 29, goa: 30, lakshadweep: 31, kerala: 32,
  "tamil nadu": 33, puducherry: 34, "andaman and nicobar islands": 35, telangana: 36, "andhra pradesh": 37, ladakh: 38,
};
export const DEFAULT_GST_RATE = 18;
export function gstStateCode(gstin, state) {
  const g = String(gstin || "").trim().toUpperCase();
  if (/^\d{2}[A-Z0-9]{13}$/.test(g)) return Number(g.slice(0, 2));
  const s = String(state || "").trim();
  if (/^\d{1,2}\b/.test(s)) return Number(s.match(/^\d{1,2}/)[0]);
  return GST_STATE_CODES[s.toLowerCase()] || null;
}
/** "IGST" or "CGST_SGST". Unknown party state counts as our own state. */
export function gstTaxType(settings, partyGstin, partyState) {
  const own = gstStateCode(settings?.company_gstin, settings?.company_state) || 27;
  const other = gstStateCode(partyGstin, partyState);
  return other && other !== own ? "IGST" : "CGST_SGST";
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
/** Tax on lines [{amount, gst_rate}], worked out per rate. */
export function gstTotals(lines, taxType) {
  const byRate = new Map();
  for (const l of lines) {
    const amt = Number(l.amount) || 0;
    if (!amt) continue;
    const raw = l.gst_rate === null || l.gst_rate === undefined || l.gst_rate === "" ? DEFAULT_GST_RATE : Number(l.gst_rate);
    const rate = Number.isFinite(raw) ? raw : DEFAULT_GST_RATE;
    byRate.set(rate, (byRate.get(rate) || 0) + amt);
  }
  let cgst = 0, igst = 0, taxable = 0;
  const rates = [...byRate.keys()].sort((a, b) => a - b);
  for (const [rate, base] of byRate) {
    taxable += base;
    if (taxType === "IGST") igst += r2((base * rate) / 100);
    else cgst += r2((base * rate) / 200);
  }
  taxable = r2(taxable); cgst = r2(cgst); igst = r2(igst);
  return { taxable, cgst, sgst: cgst, igst, tax: r2(2 * cgst + igst), total: r2(taxable + 2 * cgst + igst), rates };
}
