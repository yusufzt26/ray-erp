import { CONVERT, DOC_TYPES, LEVELS, MASTERS, MODULES, PRODUCT_CATEGORIES, ROLES } from "./fields.js";
import { readPdf } from "./pdfread.js";
import { invoicePages } from "./invoice.js";
import { morePages } from "./more.js";
import { linksPanel } from "./links.js";
import { docPrint } from "./docprint.js";
import { DASHBOARDS, defaultDash, renderDash } from "./dash.js";

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const numStr = (n) => (n === null || n === undefined || n === "" ? "" : String(+Number(n).toFixed(4)));
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isNaN(n) ? 0 : n; };

let S = { user: null, perms: {}, settings: {}, defaultPw: false };
let flashes = [];
const flash = (msg, kind = "ok") => flashes.push({ msg, kind });

class ApiError extends Error {
  constructor(status, data) { super(data?.error || (data?.errors || []).join(" ") || `Error ${status}`); this.status = status; this.data = data; }
}

async function api(method, path, body, raw = false) {
  const opts = { method, headers: { "x-requested-with": "ray-erp" }, credentials: "same-origin" };
  if (body !== undefined) {
    if (raw) { opts.body = body; opts.headers["content-type"] = "application/pdf"; }
    else { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") { S.user = null; location.hash = "#/login"; throw new ApiError(401, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const can = (module, level = "view") => LEVELS.indexOf(S.perms[module] || "none") >= LEVELS.indexOf(level);

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = label || "Please wait…"; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

// ------------------------------------------------------------------ install as an app
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; addInstallButton(); });
function addInstallButton() {
  const who = document.querySelector("header.top .who");
  if (!installPrompt || !who || document.getElementById("install")) return;
  who.insertAdjacentHTML("beforebegin", '<button class="install-btn" id="install">⬇ Install app</button>');
  document.getElementById("install").onclick = async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; document.getElementById("install")?.remove(); };
}
window.addEventListener("appinstalled", () => { installPrompt = null; document.getElementById("install")?.remove(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// ------------------------------------------------------------------ layout
function layout(body) {
  const r = location.hash;
  const on = (prefix) => (r.startsWith(prefix) ? "on" : "");
  const navGroup = (title, side, extra) => {
    const links = Object.entries(DOC_TYPES).filter(([k, d]) => d.side === side && can(k)).map(([k, d]) => `<a href="#/d/${k}" class="${on("#/d/" + k)}">${d.icon} ${d.title}</a>`).join("") + extra;
    return links ? `<div class="sec">${title}</div>${links}` : "";
  };
  const side = `
    <a href="#/" class="${r === "#/" || r === "" ? "on" : ""}">🏠 Home</a>
    ${navGroup("Sales", "sales", can("sales_invoice") ? `<a href="#/invoices" class="${on("#/invoices")}">🧾 Sales Invoices</a>` : "")}
    ${navGroup("Purchase", "purchase", "")}
    ${can("stock") || can("sales_invoice") || can("accounts") ? '<div class="sec">Stock & Accounts</div>' : ""}
    ${can("stock") ? `<a href="#/stock" class="${on("#/stock")}">📊 Stock</a>` : ""}
    ${can("sales_invoice") ? `<a href="#/sales-register" class="${on("#/sales-register")}">📈 Sales Register</a>` : ""}
    ${can("accounts") ? `<a href="#/accounts" class="${on("#/accounts") || on("#/payments")}">💰 Accounts</a>` : ""}
    <div class="sec">Masters</div>
    ${Object.entries(MASTERS).filter(([k]) => can(k)).map(([k, m]) => `<a href="#/m/${k}" class="${on("#/m/" + k)}">${m.icon} ${m.title}</a>`).join("")}
    ${can("users") ? `<div class="sec">Admin</div>
      <a href="#/users" class="${on("#/users")}">🔑 Users</a>
      <a href="#/permissions" class="${on("#/permissions")}">🛡️ Role Permissions</a>
      ${S.user.role === "Admin" ? `<a href="#/settings" class="${on("#/settings")}">⚙️ Company Settings</a>
        <a href="#/load-data" class="${on("#/load-data")}">📂 Load Old Records</a>` : ""}` : ""}`;
  document.body.innerHTML = `
    <header class="top">
      <button class="menu-btn" aria-label="Menu" onclick="document.body.classList.toggle('nav-open')">☰</button>
      <a class="brand" href="#/"><img src="/mark.png" alt=""> ${h(S.settings.company_name || "Ray Precicomp")} <span>ERP</span></a>
      <div class="who">${h(S.user.full_name)} · <b>${h(S.user.role)}</b> · <a href="#/password">Password</a> · <a href="#" id="logout">Log out</a></div>
    </header>
    <div class="layout"><nav class="side" onclick="document.body.classList.remove('nav-open')">${side}</nav>
    <main>${flashes.map((f) => `<div class="flash ${f.kind}">${h(f.msg)}</div>`).join("")}${body}</main></div>`;
  flashes = [];
  addInstallButton();
  $("#logout").onclick = async (e) => { e.preventDefault(); await api("POST", "/api/logout", {}); S.user = null; location.hash = "#/login"; };
}

const errorBox = (errs) => (errs?.length ? `<div class="flash error">${errs.map(h).join("<br>")}</div>` : "");

// ------------------------------------------------------------------ pages
const pages = {};

pages.login = () => {
  document.body.innerHTML = `
  <div class="login-box">
    <img src="/logo.png" alt="${h(S.settings.company_name || "Ray Precicomp")}" class="login-logo">
    <p class="muted">Sign in to the ERP</p>
    <div id="err"></div>
    <form id="f">
      <label>Username <input name="username" autofocus required autocomplete="username"></label>
      <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn primary wide">Sign in</button>
    </form>
  </div>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#f button");
    busy(btn, true, "Signing in…");
    try {
      await api("POST", "/api/login", Object.fromEntries(new FormData(e.target)));
      await loadMe();
      location.hash = "#/";
    } catch (err) {
      $("#err").innerHTML = errorBox([err.message]);
      busy(btn, false);
    }
  };
};

pages.dashboard = async () => {
  const quick = [
    can("sales_invoice", "edit") && ["#/invoices/new", "🧾 New Sales Invoice", "From a customer PO"],
    can("stock", "edit") && ["#/stock/entry", "📊 Stock Entry", "Opening, production, issue"],
    can("accounts", "edit") && ["#/payments/new?dir=in", "💰 Payment Received", "From a customer"],
    can("customer_po", "edit") && ["#/d/customer_po/upload", "⬆ Upload Customer PO", "PDF → auto-fill"],
    can("vendor_invoice", "edit") && ["#/d/vendor_invoice/upload", "⬆ Upload Vendor Invoice", "PDF → auto-fill"],
    can("products", "edit") && ["#/m/products/new", "＋ New Product", "Item code is automatic"],
  ].filter(Boolean);
  const views = Object.entries(DASHBOARDS).filter(([k, v]) => (k === "admin" ? S.user.role === "Admin" : can(v.perm))).map(([k]) => k);
  const asked = new URLSearchParams(location.hash.split("?")[1] || "").get("view");
  const view = views.includes(asked) ? asked : views.includes(defaultDash(S.user.role)) ? defaultDash(S.user.role) : views[0];
  const d = view ? await api("GET", `/api/dash/${view}`) : null;
  layout(`
    <div class="head"><h1>Welcome, ${h(S.user.full_name)}</h1>
      ${views.length > 1 ? `<div class="tabs dtabs">${views.map((k) => `<a href="#/?view=${k}" class="${k === view ? "on" : ""}">${DASHBOARDS[k].icon} ${DASHBOARDS[k].label}</a>`).join("")}</div>` : ""}</div>
    ${S.defaultPw ? `<div class="flash error">You are using the default admin password. <a href="#/password">Change it now</a>.</div>` : ""}
    <div class="quick slim">${quick.map(([href, t, s]) => `<a class="tile action" href="${href}"><b>${t}</b><span>${s}</span></a>`).join("")}</div>
    ${d ? renderDash(view, d) : '<p class="muted">Use the menu on the left to get started.</p>'}`);
};

pages.password = () => {
  layout(`<h1>Change password</h1><div id="err"></div>
    <form id="f" class="card narrow">
      <label>Current password <input name="current" type="password" required></label>
      <label>New password <input name="new" type="password" required minlength="6"></label>
      <label>Confirm new password <input name="confirm" type="password" required minlength="6"></label>
      <div class="buttons"><button class="btn primary">Change password</button></div>
    </form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    if (v.new !== v.confirm) { $("#err").innerHTML = errorBox(["New passwords do not match."]); return; }
    try { await api("POST", "/api/password", v); await loadMe(); flash("Password changed."); location.hash = "#/"; }
    catch (err) { $("#err").innerHTML = errorBox([err.message]); }
  };
};

// ------------------------------------------------------------------ masters
pages.masterList = async (master) => {
  const m = MASTERS[master];
  const p = new URLSearchParams(location.hash.split("?")[1] || "");
  const qs = p.get("q") || "", show = p.get("show") || "active", flt = p.get("flt") || "";
  const { rows } = await api("GET", `/api/m/${master}?` + new URLSearchParams({ q: qs, show, flt }));
  const cols = m.fields.filter((f) => f.inList);
  layout(`
    <div class="head"><h1>${m.title} <small>(${rows.length})</small></h1>
      <div class="actions">
        ${can(master, "edit") ? `<a class="btn primary" href="#/m/${master}/new">＋ New ${m.singular}</a>
          <a class="btn" href="#/m/${master}/import">⬆ Import Excel / CSV</a>` : ""}
        <button class="btn" id="exx">⬇ Excel</button><button class="btn" id="exc">⬇ CSV</button>
      </div></div>
    <form class="filters" id="flt">
      <input name="q" value="${h(qs)}" placeholder="Search code, name, part no, GSTIN…">
      ${master === "products" ? `<select name="flt"><option value="">All products</option>
        <option value="sellable" ${flt === "sellable" ? "selected" : ""}>Sellable only</option>
        <option value="purchasable" ${flt === "purchasable" ? "selected" : ""}>Purchasable only</option>
        ${Object.entries(PRODUCT_CATEGORIES).map(([k, v]) => `<option value="${k}" ${flt === k ? "selected" : ""}>${k} - ${v}</option>`).join("")}
      </select>` : ""}
      <select name="show"><option value="active">Active</option><option value="all" ${show === "all" ? "selected" : ""}>Active + inactive</option></select>
      <button class="btn">Search</button>
    </form>
    <div class="scroll"><table class="grid">
      <tr><th>${master === "products" ? "Item Code" : "Code"}</th>${cols.map((f) => `<th>${h(f.label)}</th>`).join("")}</tr>
      ${rows.map((r) => `<tr class="click ${r.active ? "" : "inactive"}" data-href="#/m/${master}/${r.id}"><td><b>${h(r.code)}</b></td>
        ${cols.map((f) => `<td>${f.type === "check" ? (r[f.key] ? "✓" : "") : h(r[f.key])}</td>`).join("")}</tr>`).join("")
        || `<tr><td colspan="${cols.length + 1}" class="muted">Nothing here yet.${can(master, "edit") ? " Add one, or import from Excel / CSV." : ""}</td></tr>`}
    </table></div>`);
  const go = () => { location.hash = `#/m/${master}?` + new URLSearchParams(new FormData($("#flt"))); };
  $("#flt").onsubmit = (e) => { e.preventDefault(); go(); };
  $$("#flt select").forEach((s) => (s.onchange = go));
  const exportRows = async (fmt) => {
    const all = (await api("GET", `/api/m/${master}?show=all`)).rows;
    const aoa = [["Code", ...m.fields.map((f) => f.label)],
      ...all.map((r) => [r.code, ...m.fields.map((f) => (f.type === "check" ? (r[f.key] ? "Yes" : "No") : r[f.key] ?? ""))])];
    downloadSheet(aoa, m.title, `${master}.${fmt}`, fmt);
  };
  $("#exx").onclick = () => exportRows("xlsx");
  $("#exc").onclick = () => exportRows("csv");
};

function fieldInput(f, v, { locked = false } = {}) {
  if (f.type === "check") return `<label class="check"><input type="checkbox" name="${f.key}" ${v ? "checked" : ""}> ${h(f.label)}</label>`;
  let input;
  if (f.type === "textarea") input = `<textarea name="${f.key}" rows="2">${h(v)}</textarea>`;
  else if (f.type === "select")
    input = `<select name="${f.key}" ${locked ? "disabled" : ""}>${f.options.map(([val, lab]) => `<option value="${h(val)}" ${v === val ? "selected" : ""}>${h(lab)}</option>`).join("")}</select>`;
  else input = `<input name="${f.key}" value="${h(v)}" ${f.required ? "required" : ""} ${f.type === "number" ? 'inputmode="decimal"' : ""} ${f.key === "gstin" ? 'maxlength="15" class="upper"' : ""}>`;
  return `<label class="${f.type === "textarea" ? "full" : ""}">${h(f.label)}${f.required ? ' <span class="req">*</span>' : ""}${input}${f.help ? `<small>${h(f.help)}</small>` : ""}</label>`;
}

pages.masterForm = async (master, id) => {
  const m = MASTERS[master];
  const isNew = id === "new";
  if (isNew && !can(master, "edit")) return pages.forbidden();
  const p = new URLSearchParams(location.hash.split("?")[1] || "");
  const row = isNew ? null : (await api("GET", `/api/m/${master}/${id}`)).row;
  const values = row || { active: 1, category: p.get("category") || "FG", uom: "NOS", sellable: master === "products" ? 1 : 0 };
  const editable = can(master, "edit");
  layout(`
    <div class="head"><h1>${row ? `${m.singular} <span class="code">${h(row.code)}</span>` : `New ${m.singular}`}</h1>
      <a class="btn" href="#/m/${master}">← Back to list</a></div>
    <div id="err"></div>
    ${row ? "" : `<p class="muted">The ${master === "products" ? "item code" : "code"} is created automatically when you save.</p>`}
    <form id="f" class="card form-grid"><fieldset ${editable ? "" : "disabled"}>
      ${m.fields.map((f) => fieldInput(f, values[f.key], { locked: f.key === "category" && !!row })).join("")}
      <label class="check full warn" id="dupbox" hidden><input type="checkbox" name="confirm_dup"> Save anyway (it is a different one)</label>
    </fieldset>
    ${editable ? `<div class="full buttons"><button class="btn primary" name="save">💾 Save</button>
      ${row ? "" : '<button class="btn" name="again">💾 Save &amp; add another</button>'}</div>` : ""}
    </form>
    ${row && editable ? '<button class="btn danger small" id="del">Delete</button>' : ""}`);
  let again = false;
  $$("#f button").forEach((b) => (b.onclick = () => { again = b.name === "again"; }));
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {};
    for (const f of m.fields) body[f.key] = f.type === "check" ? fd.has(f.key) : fd.get(f.key);
    if (row && master === "products") body.category = row.category;
    body.confirm_dup = fd.has("confirm_dup");
    const btn = e.submitter;
    busy(btn, true, "Saving…");
    try {
      const res = row ? await api("PUT", `/api/m/${master}/${row.id}`, body) : await api("POST", `/api/m/${master}`, body);
      flash(row ? `${m.singular} saved.` : `${m.singular} ${res.code} created.`);
      if (again) { location.hash = `#/m/${master}/new?category=${body.category || ""}&t=${Date.now()}`; }
      else location.hash = `#/m/${master}`;
    } catch (err) {
      busy(btn, false);
      $("#err").innerHTML = errorBox(err.data?.errors || [err.message]);
      if (err.data?.dup) $("#dupbox").hidden = false;
      scrollTo(0, 0);
    }
  };
  if (master === "products" && row && ["FG", "SA"].includes(row.category)) await more.bomCard(row, editable);
  if ($("#del")) $("#del").onclick = async () => {
    if (!confirm(`Delete ${row.code}?`)) return;
    const res = await api("DELETE", `/api/m/${master}/${row.id}`);
    flash(res.message);
    location.hash = `#/m/${master}`;
  };
};

// ------------------------------------------------------------------ Excel / CSV
function downloadSheet(aoa, sheetName, filename, fmt, extraSheets = []) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = aoa[0].map((hd) => ({ wch: Math.max(12, Math.min(40, String(hd).length + 4)) }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  if (fmt === "xlsx") for (const [name, rows] of extraSheets) {
    const s = XLSX.utils.aoa_to_sheet(rows);
    s["!cols"] = [{ wch: 30 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, s, name);
  }
  XLSX.writeFile(wb, filename, { bookType: fmt === "csv" ? "csv" : "xlsx" });
}

function templateRows(master) {
  const m = MASTERS[master];
  const head = ["Code", ...m.fields.map((f) => f.label)];
  const samples = master === "products"
    ? [{ name: "Nylon Fuel Line Assy 8x10", category: "FG", sellable: "Yes", customer_part_no: "TML-123456", drawing_no: "DRG-001", material: "PA12",
        description: "Fuel pipe assembly with quick connectors", uom: "NOS", hsn: "87089900", gst_rate: 18, sale_rate: 145.5, active: "Yes" },
       { name: "PA12 Tube 8x10 Black", category: "RM", purchasable: "Yes", material: "PA12", uom: "MTR", hsn: "39173100", gst_rate: 18, purchase_rate: 22, active: "Yes" }]
    : [{ name: "ABC Motors Pvt Ltd", gstin: "27AABCA1234B1Z5", pan: "AABCA1234B", contact_person: "Mr. Sharma", phone: "9800000000",
        email: "purchase@abc.example", address: "Plot 1, MIDC", city: "Pune", state: "Maharashtra", pincode: "411001", payment_terms: "30 days", active: "Yes" }];
  const help = [["Column", "Notes"], ["Code", "Leave blank for new records, a code is created automatically. Fill it to update an existing record."],
    ...m.fields.map((f) => [f.label + (f.required ? " (required)" : ""),
      f.key === "category" ? "One of: " + Object.entries(PRODUCT_CATEGORIES).map(([k, v]) => `${k} (${v})`).join(", ") : f.type === "check" ? "Yes / No" : f.help])];
  return { aoa: [head, ...samples.map((s) => ["", ...m.fields.map((f) => s[f.key] ?? "")])], help };
}

pages.masterImport = (master) => {
  const m = MASTERS[master];
  if (!can(master, "edit")) return pages.forbidden();
  layout(`
    <div class="head"><h1>Import ${m.title} from Excel or CSV</h1><a class="btn" href="#/m/${master}">← Back to list</a></div>
    <div class="card">
      <ol class="steps">
        <li>Download the template: <button class="btn" id="tx">⬇ Excel template</button> <button class="btn" id="tc">⬇ CSV template</button></li>
        <li>Fill one ${m.singular.toLowerCase()} per row. Leave <b>Code</b> empty for new records; ${master === "products" ? "item codes are" : "codes are"} created automatically. Put an existing code to update that record.</li>
        <li>Choose the file (.xlsx, .xls or .csv) and press Import.</li>
      </ol>
      <form id="f" class="upload">
        <input type="file" name="file" accept=".xlsx,.xls,.xlsm,.csv" required>
        <button class="btn primary">⬆ Import</button>
      </form>
    </div>
    <div id="report"></div>`);
  const t = templateRows(master);
  $("#tx").onclick = () => downloadSheet(t.aoa, m.title, `${master}_template.xlsx`, "xlsx", [["How to fill", t.help]]);
  $("#tc").onclick = () => downloadSheet(t.aoa, m.title, `${master}_template.csv`, "csv");
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const file = e.target.file.files[0];
    const btn = e.submitter;
    busy(btn, true, "Importing…");
    try {
      const rows = await sheetToRows(master, file);
      const r = await api("POST", `/api/m/${master}/import`, { rows });
      $("#report").innerHTML = `<div class="card"><h2>Import result</h2>
        <p><b>${r.added.length}</b> added, <b>${r.updated}</b> updated, <b>${r.errors.length}</b> rows skipped.</p>
        ${r.errors.length ? `<h3>Skipped rows (fix and import again)</h3><table class="grid"><tr><th>Row</th><th>Problem</th></tr>
          ${r.errors.map(([n, e]) => `<tr><td>${n}</td><td>${h(e)}</td></tr>`).join("")}</table>` : ""}
        ${r.added.length ? `<h3>New codes</h3><table class="grid"><tr><th>Code</th><th>Name</th></tr>
          ${r.added.map(([c, n]) => `<tr><td>${h(c)}</td><td>${h(n)}</td></tr>`).join("")}</table>` : ""}</div>`;
    } catch (err) {
      $("#report").innerHTML = errorBox([err.message]);
    }
    busy(btn, false);
  };
};

async function sheetToRows(master, file) {
  const m = MASTERS[master];
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", raw: file.name.toLowerCase().endsWith(".csv") });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true });
  const lookup = { code: "code", "item code": "code" };
  for (const f of m.fields) { lookup[f.label.toLowerCase()] = f.key; lookup[f.key] = f.key; }
  const header = (aoa[0] || []).map((x) => lookup[String(x).trim().toLowerCase().replace(" (required)", "")]);
  if (!header.includes("name")) throw new Error("The first row must have column headings, including a 'Name' column. Download the template to see the layout.");
  const rows = [];
  aoa.slice(1).forEach((r, i) => {
    if (!r.some((v) => String(v).trim() !== "")) return;
    const o = { __row: i + 2 };
    header.forEach((k, j) => { if (k) o[k] = typeof r[j] === "number" && Number.isInteger(r[j]) && k !== "gst_rate" ? String(r[j]) : r[j]; });
    rows.push(o);
  });
  return rows;
}

// ------------------------------------------------------------------ documents
pages.docList = async (type) => {
  const d = DOC_TYPES[type];
  const qs = new URLSearchParams(location.hash.split("?")[1] || "").get("q") || "";
  const { rows } = await api("GET", `/api/d/${type}?` + new URLSearchParams({ q: qs }));
  layout(`
    <div class="head"><h1>${d.title} <small>(${rows.length})</small></h1>
      <div class="actions">
        ${can(type, "edit") ? (d.pdf ? `<a class="btn primary" href="#/d/${type}/upload">⬆ Upload PDF</a><a class="btn" href="#/d/${type}/new">＋ Enter manually</a>`
          : `<a class="btn primary" href="#/d/${type}/new">＋ New ${h(d.singular)}</a>`) : ""}
        <button class="btn" id="exx">⬇ Excel</button><button class="btn" id="exc">⬇ CSV</button>
      </div></div>
    <form class="filters" id="flt"><input name="q" value="${h(qs)}" placeholder="Search ${h(d.noLabel)}, ref or ${d.partyLabel.toLowerCase()}…"><button class="btn">Search</button></form>
    <div class="scroll"><table class="grid">
      <tr><th>Ref</th><th>${h(d.noLabel)}</th><th>${h(d.dateLabel)}</th><th>${d.partyLabel}</th><th class="num">Total</th><th>Status</th><th>PDF</th></tr>
      ${rows.map((r) => `<tr class="click" data-href="#/d/${type}/${r.id}"><td><b>${h(r.ref_no)}</b></td><td>${h(r.doc_no)}</td><td>${h(r.doc_date)}</td>
        <td>${h(r.party_name)}</td><td class="num">${money(r.total_amount)}</td><td><span class="pill">${h(r.status)}</span></td><td>${r.pdf_file ? "📄" : ""}</td></tr>`).join("")
        || `<tr><td colspan="7" class="muted">No ${d.title.toLowerCase()} yet.</td></tr>`}
    </table></div>`);
  $("#flt").onsubmit = (e) => { e.preventDefault(); location.hash = `#/d/${type}?` + new URLSearchParams(new FormData(e.target)); };
  const exp = async (fmt) => {
    const { rows } = await api("GET", `/api/d/${type}/lines`);
    const aoa = [["Ref No", d.noLabel, d.dateLabel, d.partyLabel, "GSTIN", "Status", "Line", "Item Code", "Party Part No", "Description", "HSN", "Qty", "UOM", "Rate", "Amount", "Document Total"],
      ...rows.map((r) => [r.ref_no, r.doc_no, r.doc_date, r.party_name, r.party_gstin, r.status, r.line_no, r.item_code, r.party_part_no, r.description, r.hsn, r.qty, r.uom, r.rate, r.amount, r.total_amount])];
    downloadSheet(aoa, "Lines", `${type}.${fmt}`, fmt);
  };
  $("#exx").onclick = () => exp("xlsx");
  $("#exc").onclick = () => exp("csv");
};

pages.docUpload = (type) => {
  const d = DOC_TYPES[type];
  if (!can(type, "edit")) return pages.forbidden();
  layout(`
    <div class="head"><h1>Upload ${d.singular}</h1><a class="btn" href="#/d/${type}">← Back to list</a></div>
    <div class="card">
      <p>Choose the PDF ${type === "customer_po" ? "purchase order you received from the customer" : "invoice you received from the vendor"}.
      The app reads it and fills in the ${h(d.noLabel)}, date, ${d.partyLabel.toLowerCase()}, GSTIN, items and totals.
      You will see the PDF next to the form, so you can check and correct everything before saving.</p>
      <div id="err"></div>
      <label class="drop" id="drop"><input type="file" accept="application/pdf,.pdf" id="file">
        <b>Click to choose a PDF</b> or drag it here<br><span id="fname" class="muted"></span></label>
      <p class="muted">Works best with PDFs generated from a computer (ERP / Tally / SAP / OEM portals). Scanned photos have no text, so you'll type those in.</p>
    </div>`);
  const drop = $("#drop"), inp = $("#file");
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hover"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hover"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
  inp.onchange = () => inp.files[0] && handle(inp.files[0]);
  async function handle(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { $("#err").innerHTML = errorBox(["Please choose a PDF file."]); return; }
    if (file.size > 4.5 * 1024 * 1024) { $("#err").innerHTML = errorBox(["This PDF is larger than 4.5 MB. Please compress it or enter it manually."]); return; }
    $("#fname").textContent = `Reading ${file.name}…`;
    try {
      const buf = await file.arrayBuffer();
      const ex = await readPdf(buf, type, S.settings.company_gstin || "");
      $("#fname").textContent = "Uploading and matching…";
      const [{ key }, match] = await Promise.all([
        api("POST", `/api/pdf/${type}`, new Blob([buf], { type: "application/pdf" }), true),
        api("POST", `/api/d/${type}/match`, { text: ex.text, party_gstin: ex.party_gstin, party_name: ex.party_name, lines: ex.lines }),
      ]);
      const doc = {
        doc_no: ex.doc_no || "", doc_date: ex.doc_date || "", delivery_date: ex.delivery_date || "",
        party_id: match.party?.id || null, party_name: match.party?.name || ex.party_name,
        party_gstin: ex.party_gstin || match.party?.gstin || "", total_amount: ex.total_amount,
        pdf_file: key, status: d.statuses[0], notes: "",
      };
      const lines = ex.lines.map((l, i) => ({ ...l, product_id: match.productIds[i], create_product: !match.productIds[i] }));
      const found = { name: file.name, doc_no: !!ex.doc_no, doc_date: !!ex.doc_date, party: !!match.party, how: match.how,
        lines: lines.length, total: !!ex.total_amount, gstins: ex.all_gstins, scanned: ex.scanned, text: ex.text,
        pdfUrl: URL.createObjectURL(file) };
      await pages.docForm(type, null, { doc, lines, found });
    } catch (err) {
      console.error(err);
      $("#fname").textContent = "";
      $("#err").innerHTML = errorBox([`Could not read this PDF (${err.message}). You can still enter the details by hand.`]);
    }
  }
};

function lineRow(l, products, flag, type) {
  const defCat = type === "customer_po" ? "FG" : "RM";
  return `<tr>
    <td class="ln"></td>
    <td><select name="product_id" class="prod ${l.found && l.product_id ? "auto" : ""}"><option value="">— not linked —</option>
      ${products.map((p) => `<option value="${p.id}" ${l.product_id === p.id ? "selected" : ""}>${h(p.code)} · ${h(p.name)}${p[flag] ? "" : ` (not ${flag})`}</option>`).join("")}</select></td>
    <td><input name="party_part_no" value="${h(l.party_part_no)}"></td>
    <td><input name="description" value="${h(l.description)}"></td>
    <td><input name="hsn" value="${h(l.hsn)}"></td>
    <td><input name="qty" value="${numStr(l.qty)}" inputmode="decimal"></td>
    <td><input name="uom" value="${h(l.uom)}"></td>
    <td><input name="rate" value="${numStr(l.rate)}" inputmode="decimal"></td>
    <td><input name="amount" value="${l.amount === null || l.amount === undefined || l.amount === "" ? "" : Number(l.amount).toFixed(2)}" inputmode="decimal"></td>
    <td><span class="newbox" ${l.product_id ? "hidden" : ""}><label class="check inline"><input type="checkbox" name="create" ${l.create_product ? "checked" : ""}> create</label>
      <select name="category" title="Category for the new item code">${Object.keys(PRODUCT_CATEGORIES).map((k) => `<option ${k === defCat ? "selected" : ""}>${k}</option>`).join("")}</select></span></td>
    <td><button type="button" class="rm" title="Remove line">✕</button></td></tr>`;
}

pages.docForm = async (type, id, preset = null) => {
  const d = DOC_TYPES[type];
  if (!id && !can(type, "edit")) return pages.forbidden();
  const [{ parties, products }, existing] = await Promise.all([
    api("GET", `/api/d/${type}/options`),
    id ? api("GET", `/api/d/${type}/${id}`) : Promise.resolve(null),
  ]);
  const doc = existing?.doc || preset?.doc || { status: d.statuses[0] };
  const lines = existing?.lines || preset?.lines || [];
  const found = preset?.found || null;
  const editable = can(type, "edit");
  const flag = d.productFlag;
  const cls = (hit) => (found ? (hit ? "auto" : "missing") : "");
  const pdfUrl = found?.pdfUrl || (doc.pdf_file ? `/api/pdf/${type}/${doc.pdf_file}` : null);
  if (found) lines.forEach((l) => (l.found = true));

  layout(`
    <div class="head"><h1>${doc.id ? `${d.singular} <span class="code">${h(doc.ref_no)}</span>` : `New ${d.singular}`}</h1>
      <div class="actions">${doc.id ? convertButtons(type, doc) : ""}
      ${doc.id && d.printTitle ? `<a class="btn" href="#/d/${type}/${doc.id}/print">🖨 Print</a>` : ""}
      <a class="btn" href="#/d/${type}">← Back to list</a></div></div>
    ${preset?.source ? `<div class="flash ok">Made from ${h(DOC_TYPES[preset.source.type].singular)} ${h(preset.source.ref_no)}: only the quantity still pending is filled in. Check and save.</div>` : ""}
    <div id="err"></div>
    ${found ? `<div class="detect"><b>Read from PDF "${h(found.name)}":</b>
      ${found.scanned ? '<span class="miss">This PDF looks scanned (no text inside). Please type the details while looking at the PDF.</span>' : `
      <span class="${found.doc_no ? "hit" : "miss"}">${h(d.noLabel)}</span>
      <span class="${found.doc_date ? "hit" : "miss"}">Date</span>
      <span class="${found.party ? "hit" : "miss"}">${d.partyLabel}${found.party ? ` (by ${found.how})` : " not in master"}</span>
      <span class="${found.lines ? "hit" : "miss"}">${found.lines} item line${found.lines === 1 ? "" : "s"}</span>
      <span class="${found.total ? "hit" : "miss"}">Total</span>
      <br><small class="muted">Green = filled automatically, please check. Red = not found, please fill. Yellow boxes were auto-filled.</small>`}</div>` : ""}
    <form id="f" class="${pdfUrl ? "split" : ""}">
      <div class="card hdr"><fieldset ${editable ? "" : "disabled"}><div class="form-grid">
        <label>${d.partyLabel} <span class="req">*</span>
          <select name="party_id" id="party_id" class="${found && found.party ? "auto" : ""}"><option value="">— not in list / new —</option>
            ${parties.map((p) => `<option value="${p.id}" data-name="${h(p.name)}" data-gstin="${h(p.gstin)}" ${doc.party_id === p.id ? "selected" : ""}>${h(p.name)} (${h(p.code)})</option>`).join("")}
          </select></label>
        <label>${d.partyLabel} name as on document
          <input name="party_name" id="party_name" required value="${h(doc.party_name)}" class="${found && doc.party_name ? "auto" : ""}"></label>
        <label>${d.partyLabel} GSTIN
          <input name="party_gstin" id="party_gstin" maxlength="15" value="${h(doc.party_gstin)}" class="upper ${found && doc.party_gstin ? "auto" : ""}">
          ${found && found.gstins.length > 1 ? `<small>GSTINs in PDF: ${found.gstins.map(h).join(", ")}</small>` : ""}</label>
        <label class="check" id="create_party_box" ${doc.party_id ? "hidden" : ""}><input type="checkbox" name="create_party" ${found && !found.party ? "checked" : ""}> Add as new ${d.partyLabel.toLowerCase()} in master</label>
        <label>${h(d.noLabel)} ${d.own ? "" : '<span class="req">*</span>'}<input name="doc_no" ${d.own ? `placeholder="Given automatically"` : "required"} value="${h(doc.doc_no)}" class="${cls(found?.doc_no)}"></label>
        <label>${h(d.dateLabel)}<input name="doc_date" type="date" value="${h(doc.doc_date)}" class="${cls(found?.doc_date)}"></label>
        ${type === "customer_po" ? `<label>Delivery date<input name="delivery_date" type="date" value="${h(doc.delivery_date)}" class="${found && doc.delivery_date ? "auto" : ""}"></label>` : ""}
        <label>Status<select name="status">${d.statuses.map((s) => `<option ${doc.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      </div></fieldset></div>
      ${pdfUrl ? `<div class="pdfpane"><iframe src="${pdfUrl}" title="PDF"></iframe>
        <a href="${pdfUrl}" target="_blank" rel="noopener">Open PDF in new tab</a>
        ${found?.text ? `<details><summary>Text found in PDF (copy from here)</summary><pre>${h(found.text)}</pre></details>` : ""}</div>` : ""}
      <div class="card items"><fieldset ${editable ? "" : "disabled"}>
        <h2>Items</h2>
        <div class="scroll"><table class="lines"><thead><tr><th>#</th><th>Our item</th><th>Part No</th><th>Description</th><th>HSN</th><th>Qty</th><th>UOM</th><th>Rate</th><th>Amount</th><th>New product?</th><th></th></tr></thead>
          <tbody id="lines">${lines.map((l) => lineRow(l, products, flag, type)).join("")}</tbody></table></div>
        ${editable ? '<button type="button" class="btn small" id="addline">＋ Add line</button>' : ""}
        <div class="totals">
          <div>Items total: <b id="subtotal">0.00</b></div>
          <label>Document total (incl. tax)<input name="total_amount" id="total_amount" inputmode="decimal" value="${doc.total_amount === null || doc.total_amount === undefined ? "" : Number(doc.total_amount).toFixed(2)}" class="${cls(found?.total)}"></label>
          <div>Tax / other: <b id="taxdiff">0.00</b></div>
        </div>
        <label class="full">Notes <textarea name="notes" rows="2">${h(doc.notes)}</textarea></label>
      </fieldset>
      ${editable ? `<div class="buttons"><button class="btn primary">💾 Save ${d.singular}</button>
        ${found ? `<a class="btn" href="#/d/${type}/upload">Cancel</a>` : ""}</div>` : ""}
      </div>
    </form>
    <div id="links"></div>
    ${doc.id && editable ? '<button class="btn danger small" id="del">Delete</button>' : ""}`);
  if (doc.id) linksPanel(api, "doc", doc.id).then((html) => { if ($("#links")) $("#links").innerHTML = html; }).catch(() => {});

  const tbody = $("#lines");
  const renumber = () => { $$("tr", tbody).forEach((r, i) => ($(".ln", r).textContent = i + 1)); recalc(); };
  const recalc = () => {
    const s = $$("[name=amount]", tbody).reduce((a, i) => a + num(i.value), 0);
    const t = num($("#total_amount").value);
    $("#subtotal").textContent = money(s);
    $("#taxdiff").textContent = money(t ? t - s : 0);
  };
  const addLine = () => { tbody.insertAdjacentHTML("beforeend", lineRow({}, products, flag, type)); renumber(); };
  if ($("#addline")) $("#addline").onclick = addLine;
  tbody.addEventListener("click", (e) => { if (e.target.classList.contains("rm")) { e.target.closest("tr").remove(); renumber(); } });
  tbody.addEventListener("change", (e) => {
    const r = e.target.closest("tr");
    const f = (n) => $(`[name=${n}]`, r);
    if (e.target.name === "product_id") {
      const p = products.find((p) => String(p.id) === e.target.value);
      if (p) {
        if (!f("description").value) f("description").value = p.name;
        if (!f("party_part_no").value && p.customer_part_no) f("party_part_no").value = p.customer_part_no;
        if (!f("uom").value) f("uom").value = p.uom || "";
        if (!f("hsn").value) f("hsn").value = p.hsn || "";
        const rate = type === "customer_po" ? p.sale_rate : p.purchase_rate;
        if (!f("rate").value && rate) f("rate").value = rate;
        f("create").checked = false;
      }
      $(".newbox", r).hidden = !!p;
    }
    if (["qty", "rate", "product_id"].includes(e.target.name) && f("qty").value && f("rate").value)
      f("amount").value = (num(f("qty").value) * num(f("rate").value)).toFixed(2);
    recalc();
  });
  tbody.addEventListener("input", (e) => e.target.name === "amount" && recalc());
  $("#total_amount").addEventListener("input", recalc);
  $("#party_id").onchange = (e) => {
    const o = e.target.selectedOptions[0];
    $("#create_party_box").hidden = !!e.target.value;
    if (e.target.value) { $("#party_name").value = o.dataset.name; if (o.dataset.gstin) $("#party_gstin").value = o.dataset.gstin; }
  };
  if (!lines.length && editable) addLine();
  renumber();

  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(["party_id", "party_name", "party_gstin", "doc_no", "doc_date", "delivery_date", "status", "total_amount", "notes"].map((k) => [k, fd.get(k)]));
    body.create_party = fd.has("create_party");
    body.parent_id = doc.parent_id || null;
    body.id = doc.id || null;
    body.pdf_file = doc.pdf_file || "";
    body.lines = $$("tr", tbody).map((r) => ({
      product_id: $("[name=product_id]", r).value, party_part_no: $("[name=party_part_no]", r).value,
      description: $("[name=description]", r).value, hsn: $("[name=hsn]", r).value, qty: $("[name=qty]", r).value,
      uom: $("[name=uom]", r).value, rate: $("[name=rate]", r).value, amount: $("[name=amount]", r).value,
      create: !$(".newbox", r).hidden && $("[name=create]", r).checked, category: $("[name=category]", r).value,
    }));
    const btn = e.submitter;
    busy(btn, true, "Saving…");
    try {
      const res = await api("POST", `/api/d/${type}/save`, body);
      res.messages.forEach((m) => flash(m, m.startsWith("Note:") ? "error" : "ok"));
      flash(`${d.singular} ${res.ref_no} saved.`);
      if (location.hash === `#/d/${type}/${res.id}`) route(); else location.hash = `#/d/${type}/${res.id}`;
    } catch (err) {
      busy(btn, false);
      $("#err").innerHTML = errorBox([err.message]);
      scrollTo(0, 0);
    }
  };
  if ($("#del")) $("#del").onclick = async () => {
    if (!confirm(`Delete ${doc.ref_no}?`)) return;
    await api("DELETE", `/api/d/${type}/${doc.id}`);
    flash("Deleted.");
    location.hash = `#/d/${type}`;
  };
};

function convertButtons(type, doc) {
  const out = [];
  for (const t of CONVERT[type] || []) {
    if (t === "invoice") { if (can("sales_invoice", "edit")) out.push(`<a class="btn primary" href="#/invoices/new?from=${doc.id}">🧾 Make Invoice</a>`); }
    else if (can(t, "edit")) out.push(`<a class="btn primary" href="#/d/${t}/new?from=${doc.id}">${DOC_TYPES[t].icon} Make ${h(DOC_TYPES[t].singular)}</a>`);
  }
  if (type === "vendor_invoice" && can("accounts", "edit") && doc.party_id)
    out.push(`<a class="btn" href="#/payments/new?dir=out&party=${doc.party_id}&amount=${doc.total_amount || ""}&ref=${encodeURIComponent(doc.doc_no || "")}">💰 Record payment</a>`);
  return out.join("");
}

// ------------------------------------------------------------------ admin
pages.users = async () => {
  if (!can("users")) return pages.forbidden();
  const { rows } = await api("GET", "/api/users");
  layout(`
    <div class="head"><h1>Users <small>(${rows.length})</small></h1><div class="actions">
      ${can("users", "edit") ? '<a class="btn primary" href="#/users/new">＋ New User</a>' : ""}
      <a class="btn" href="#/permissions">🛡️ What each role can do</a></div></div>
    <div class="scroll"><table class="grid"><tr><th>Username</th><th>Full name</th><th>Role</th><th>Email</th><th>Phone</th><th>Active</th></tr>
      ${rows.map((r) => `<tr class="click ${r.active ? "" : "inactive"}" data-href="#/users/${r.id}"><td><b>${h(r.username)}</b></td><td>${h(r.full_name)}</td>
        <td><span class="pill">${h(r.role)}</span></td><td>${h(r.email)}</td><td>${h(r.phone)}</td><td>${r.active ? "✓" : ""}</td></tr>`).join("")}
    </table></div>`);
};

pages.userForm = async (id) => {
  if (!can("users", id === "new" ? "edit" : "view")) return pages.forbidden();
  const row = id === "new" ? null : (await api("GET", "/api/users")).rows.find((u) => String(u.id) === id);
  const v = row || { role: "Sales", active: 1 };
  const ed = can("users", "edit");
  layout(`
    <div class="head"><h1>${row ? "Edit user" : "New user"}</h1><a class="btn" href="#/users">← Back to users</a></div>
    <div id="err"></div>
    <form id="f" class="card form-grid"><fieldset ${ed ? "" : "disabled"}>
      <label>Username <span class="req">*</span><input name="username" value="${h(v.username)}" required autocomplete="off"><small>Used to log in, e.g. ravi.store</small></label>
      <label>Full name <span class="req">*</span><input name="full_name" value="${h(v.full_name)}" required></label>
      <label>Role <span class="req">*</span><select name="role">${ROLES.map((r) => `<option ${v.role === r ? "selected" : ""}>${r}</option>`).join("")}</select>
        <small><a href="#/permissions">See what each role can do</a></small></label>
      <label>${row ? "New password (leave blank to keep)" : 'Password <span class="req">*</span>'}<input name="password" type="password" autocomplete="new-password" ${row ? "" : "required"} minlength="6"></label>
      <label>Email<input name="email" type="email" value="${h(v.email)}"></label>
      <label>Phone<input name="phone" value="${h(v.phone)}"></label>
      <label class="check"><input type="checkbox" name="active" ${v.active ? "checked" : ""}> Active (can log in)</label>
    </fieldset>${ed ? '<div class="full buttons"><button class="btn primary">💾 Save user</button></div>' : ""}</form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd);
    body.active = fd.has("active");
    try {
      row ? await api("PUT", `/api/users/${row.id}`, body) : await api("POST", "/api/users", body);
      flash("User saved.");
      location.hash = "#/users";
    } catch (err) { $("#err").innerHTML = errorBox([err.message]); }
  };
};

pages.permissions = async () => {
  if (!can("users")) return pages.forbidden();
  const { rows } = await api("GET", "/api/permissions");
  const perms = Object.fromEntries(rows.map((r) => [`${r.role}:${r.module}`, r.level]));
  const ed = can("users", "edit");
  layout(`
    <h1>Role permissions</h1>
    <p class="muted"><b>None</b> = menu hidden. <b>View</b> = can see and export. <b>Edit</b> = can add, change, import and delete. Admin always has full access.</p>
    <form id="f" class="card"><div class="scroll"><table class="grid perm">
      <tr><th>Module</th>${ROLES.map((r) => `<th>${r}</th>`).join("")}</tr>
      ${Object.entries(MODULES).map(([mod, label]) => `<tr><td><b>${label}</b></td>${ROLES.map((r) => `<td>${r === "Admin" ? '<span class="pill">edit</span>' :
        `<select name="${r}:${mod}" class="lvl-${perms[`${r}:${mod}`] || "none"}" ${ed ? "" : "disabled"}>${LEVELS.map((l) => `<option ${(perms[`${r}:${mod}`] || "none") === l ? "selected" : ""}>${l}</option>`).join("")}</select>`}</td>`).join("")}</tr>`).join("")}
    </table></div>${ed ? '<div class="buttons"><button class="btn primary">💾 Save permissions</button></div>' : ""}</form>`);
  $$("#f select").forEach((s) => (s.onchange = () => (s.className = "lvl-" + s.value)));
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    await api("PUT", "/api/permissions", { perms: Object.fromEntries(new FormData(e.target)) });
    flash("Role permissions saved.");
    route();
  };
};

pages.settings = async () => {
  if (S.user.role !== "Admin") return pages.forbidden();
  const s = S.settings;
  const { rows } = await api("GET", "/api/invoice-counter");
  const fy = (() => { const d = new Date(); return String((d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1) % 100).padStart(2, "0"); })();
  const last = rows.find((r) => r.name === "invoice_" + fy)?.value ?? 0;
  const inp = (k, label, help = "", extra = "") => `<label>${label}<input name="${k}" value="${h(s[k])}" ${extra}>${help ? `<small>${help}</small>` : ""}</label>`;
  const ta = (k, label, rows = 3) => `<label class="full">${label}<textarea name="${k}" rows="${rows}">${h(s[k])}</textarea></label>`;
  layout(`
    <h1>Company settings</h1>
    <p class="muted">These details print on every invoice.</p>
    <form id="f" class="card form-grid">
      ${inp("company_name", "Company name")}
      ${inp("company_gstin", "Our GSTIN", "Also used when reading PDFs: our own GSTIN is skipped so the customer's or vendor's is picked.", 'maxlength="15" class="upper"')}
      ${inp("company_pan", "Our PAN", "", 'class="upper"')}
      ${inp("company_state", "State code", "e.g. 27 Maharashtra")}
      ${inp("company_gst_wef", "GST W.E.F.", "e.g. 01/07/2017")}
      ${inp("company_email", "Email")}
      ${inp("company_mobile", "Mobile")}
      ${inp("invoice_prefix", "Invoice number prefix", "Invoices are numbered PREFIX/YY-NNN, e.g. R/26-005")}
      ${ta("company_address", "Address", 2)}
      ${ta("company_tagline", "Tagline under the logo", 2)}
      ${ta("bank_details", "Bank details")}
      ${ta("invoice_terms", "Terms & conditions")}
      ${ta("invoice_declaration", "Declaration", 4)}
      <div class="full buttons"><button class="btn primary">💾 Save</button></div>
    </form>
    <form id="cnt" class="card form-grid">
      <h2 class="full">Invoice number series</h2>
      <label>Financial year<input name="fy" value="${fy}" maxlength="2"><small>26 = April 2026 to March 2027</small></label>
      <label>Last invoice number used<input name="last" value="${last}" inputmode="numeric"><small>Next invoice will be ${h(s.invoice_prefix || "R")}/${fy}-${String(Number(last) + 1).padStart(3, "0")}</small></label>
      <div class="full buttons"><button class="btn">Update series</button></div>
    </form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    await api("PUT", "/api/settings", Object.fromEntries(new FormData(e.target)));
    await loadMe();
    flash("Settings saved.");
    route();
  };
  $("#cnt").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("PUT", "/api/invoice-counter", Object.fromEntries(new FormData(e.target))); flash("Invoice series updated."); route(); }
    catch (err) { flash(err.message, "error"); route(); }
  };
};

pages.forbidden = () => layout(`<h1>Not allowed</h1><p>Your role does not have access to this page. Ask the Admin if you need it.</p><p><a class="btn" href="#/">Back to Home</a></p>`);
pages.notFound = () => layout(`<h1>Page not found</h1><p><a class="btn" href="#/">Back to Home</a></p>`);

const more = morePages({ api, layout, can, flash, $, $$, errorBox, busy, get S() { return S; }, forbidden: () => pages.forbidden() });
const inv = invoicePages({ api, layout, can, flash, $, $$, errorBox, busy, get S() { return S; }, forbidden: () => pages.forbidden() });

// ------------------------------------------------------------------ router
async function loadMe() {
  const me = await api("GET", "/api/me");
  S = { user: me.user, perms: me.perms || {}, settings: me.settings || S.settings, defaultPw: me.defaultPw };
}

async function route() {
  const path = (location.hash.slice(1) || "/").split("?")[0];
  if (!S.user && path !== "/login") { location.hash = "#/login"; return; }
  if (path === "/login") return S.user ? (location.hash = "#/") : pages.login();
  const p = path.split("/").filter(Boolean);
  try {
    if (!p.length) return await pages.dashboard();
    if (p[0] === "m" && MASTERS[p[1]]) {
      if (!can(p[1])) return pages.forbidden();
      if (p.length === 2) return await pages.masterList(p[1]);
      if (p[2] === "import") return pages.masterImport(p[1]);
      return await pages.masterForm(p[1], p[2]);
    }
    if (p[0] === "d" && DOC_TYPES[p[1]]) {
      if (!can(p[1])) return pages.forbidden();
      if (p.length === 2) return await pages.docList(p[1]);
      if (p[2] === "upload") return pages.docUpload(p[1]);
      if (p[3] === "print") return await docPrint({ api, layout, S }, p[1], p[2]);
      const from = new URLSearchParams(location.hash.split("?")[1] || "").get("from");
      if (p[2] === "new" && from) {
        if (!can(p[1], "edit")) return pages.forbidden();
        return await pages.docForm(p[1], null, await api("GET", `/api/convert/${from}/${p[1]}`));
      }
      return await pages.docForm(p[1], p[2] === "new" ? null : p[2]);
    }
    if (p[0] === "invoices") {
      if (!can("sales_invoice")) return pages.forbidden();
      if (!p[1]) return await inv.list();
      if (p[1] === "new") return await inv.form(null);
      if (p[2] === "print") return await inv.print(p[1]);
      return await inv.form(p[1]);
    }
    if (p[0] === "stock") {
      if (!can("stock")) return pages.forbidden();
      if (!p[1]) return await more.stockList();
      if (p[1] === "entry") return await more.stockEntry();
      if (p[1] === "moves") return await more.stockMoves();
      return await more.stockItem(p[1]);
    }
    if (p[0] === "load-data") return await more.loadData();
    if (p[0] === "sales-register") return can("sales_invoice") ? await more.salesRegister() : pages.forbidden();
    if (p[0] === "accounts" || p[0] === "payments") {
      if (!can("accounts")) return pages.forbidden();
      if (p[0] === "payments") return p[1] === "new" ? await more.paymentForm() : await more.payments();
      return p[1] ? await more.statement(p[1], p[2]) : await more.accounts();
    }
    if (p[0] === "users") return p[1] ? await pages.userForm(p[1]) : await pages.users();
    if (p[0] === "permissions") return await pages.permissions();
    if (p[0] === "settings") return await pages.settings();
    if (p[0] === "password") return pages.password();
    return pages.notFound();
  } catch (err) {
    if (err.status === 401) return;
    if (err.status === 403) return pages.forbidden();
    layout(errorBox([err.message]));
  }
}

document.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-href]");
  if (tr) location.hash = tr.dataset.href;
});
window.addEventListener("hashchange", () => { scrollTo(0, 0); route(); });

(async () => {
  try { await loadMe(); } catch { /* not logged in */ }
  route();
})();
