// Shared by the browser app and the API function. One definition drives the
// list pages, add/edit forms, Excel/CSV templates, import and export.

export const ROLES = ["Admin", "Purchaser", "Sales", "Store", "Production"];
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
  accounts: "Accounts (receivable / payable)",
  purchase_order: "Purchase Orders",
  grn: "Goods Receipts (GRN)",
  vendor_invoice: "Vendor Invoices",
  users: "Users & Roles",
};

export const PRODUCT_CATEGORIES = {
  FG: "Finished Good (pipe / assembly)",
  SA: "Sub-Assembly",
  CP: "Child Part",
  RM: "Raw Material",
  BO: "Bought-Out Item",
  CN: "Consumable",
  PK: "Packing Material",
};

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
  F("uom", "Unit (UOM)", { type: "select", inList: true, options: ["NOS", "SET", "KG", "MTR", "LTR", "BOX", "PCS", "ROLL"].map((u) => [u, u]) }),
  F("hsn", "HSN Code"),
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
    s = s ? s.toUpperCase().slice(0, 2) : "FG";
    if (!PRODUCT_CATEGORIES[s]) throw new Error(`Category '${raw}' is not one of ${Object.keys(PRODUCT_CATEGORIES).join(", ")}`);
  }
  if (field.key === "uom" && s) s = s.toUpperCase();
  return s || null;
}
