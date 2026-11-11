// Stock, Sales Register and Accounts screens.
import { PRODUCT_CATEGORIES } from "./fields.js";

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const dmy = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isNaN(n) ? 0 : n; };
const params = () => new URLSearchParams(location.hash.split("?")[1] || "");
const fyStart = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-04-01`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym) => { const [y, m] = ym.split("-"); return `${MONTHS[Number(m) - 1]} ${y}`; };

function saveSheets(filename, sheets, fmt = "xlsx") {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of fmt === "csv" ? sheets.slice(0, 1) : sheets) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = (aoa[0] || []).map((hd) => ({ wch: Math.max(12, Math.min(40, String(hd).length + 4)) }));
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename, { bookType: fmt === "csv" ? "csv" : "xlsx" });
}

/** A delete button that asks "sure?" on the page instead of a popup. */
function confirmButton(btn, action) {
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1"; btn.dataset.orig = btn.innerHTML; btn.innerHTML = "Sure? Click again"; btn.classList.add("danger");
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.innerHTML = btn.dataset.orig; } }, 4000);
      return;
    }
    btn.disabled = true;
    await action();
  };
}

export function morePages(ctx) {
  const { api, layout, can, flash, $, $$, errorBox, busy } = ctx;
  const route = () => window.dispatchEvent(new HashChangeEvent("hashchange"));

  // ============================================================== STOCK
  const KINDS = [
    ["Opening", "Opening stock", "Stock you already have when you start using the ERP"],
    ["Production", "Production done", "Finished / semi-finished goods made. You can also enter raw material used"],
    ["Issue", "Issue to shop floor", "Material taken out of the store for use"],
    ["Adjustment", "Correction (+ / −)", "Physical count differs: type +5 to add or -5 to reduce"],
  ];

  async function stockList() {
    const p = params();
    const qs = p.get("q") || "", cat = p.get("cat") || "";
    const { rows } = await api("GET", "/api/stock?" + new URLSearchParams({ q: qs, cat }));
    const shown = p.get("only") === "instock" ? rows.filter((r) => Number(r.balance) !== 0) : rows;
    layout(`
      <div class="head"><h1>Stock <small>(${shown.length} items)</small></h1>
        <div class="actions">
          ${can("stock", "edit") ? '<a class="btn primary" href="#/stock/entry">＋ Stock entry</a>' : ""}
          <a class="btn" href="#/stock/moves">📋 Entries made</a>
          <button class="btn" id="exx">⬇ Excel</button><button class="btn" id="exc">⬇ CSV</button>
        </div></div>
      <p class="muted small">Stock goes <b>up</b> with vendor invoices and stock entries, and goes <b>down</b> with sales invoices. Click an item to see its history.</p>
      <form class="filters" id="flt">
        <input name="q" value="${h(qs)}" placeholder="Search item code, name, part no…">
        <select name="cat"><option value="">All categories</option>
          ${Object.entries(PRODUCT_CATEGORIES).map(([k, v]) => `<option value="${k}" ${cat === k ? "selected" : ""}>${k} - ${v}</option>`).join("")}</select>
        <select name="only"><option value="">All items</option><option value="instock" ${p.get("only") === "instock" ? "selected" : ""}>Only items with stock</option></select>
        <button class="btn">Search</button>
      </form>
      <div class="scroll"><table class="grid">
        <tr><th>Item Code</th><th>Name</th><th>Part No</th><th>UOM</th><th class="num">Received</th><th class="num">Entries (+/−)</th><th class="num">Dispatched</th><th class="num">In Stock</th></tr>
        ${shown.map((r) => `<tr class="click" data-href="#/stock/${r.id}"><td><b>${h(r.code)}</b></td><td>${h(r.name)}</td><td>${h(r.customer_part_no)}</td><td>${h(r.uom)}</td>
          <td class="num">${qtyFmt(r.received)}</td><td class="num">${qtyFmt(r.manual)}</td><td class="num">${qtyFmt(r.dispatched)}</td>
          <td class="num stockbal ${Number(r.balance) < 0 ? "neg" : ""}">${qtyFmt(r.balance)}</td></tr>`).join("")
          || '<tr><td colspan="8" class="muted">No items found. Add products first.</td></tr>'}
      </table></div>`);
    const go = () => { location.hash = "#/stock?" + new URLSearchParams(new FormData($("#flt"))); };
    $("#flt").onsubmit = (e) => { e.preventDefault(); go(); };
    $$("#flt select").forEach((s) => (s.onchange = go));
    const exp = (fmt) => saveSheets(`stock_${today()}.${fmt}`, [["Stock", [["Item Code", "Name", "Category", "Part No", "UOM", "Received", "Entries", "Dispatched", "In Stock"],
      ...shown.map((r) => [r.code, r.name, r.category, r.customer_part_no, r.uom, Number(r.received), Number(r.manual), Number(r.dispatched), Number(r.balance)])]]], fmt);
    $("#exx").onclick = () => exp("xlsx");
    $("#exc").onclick = () => exp("csv");
  }

  async function stockItem(id) {
    const { product, rows, balance } = await api("GET", `/api/stock/item/${id}`);
    layout(`
      <div class="head"><h1>${h(product.code)} · ${h(product.name)}</h1>
        <div class="actions"><a class="btn" href="#/stock">← Stock</a>
          ${can("stock", "edit") ? `<a class="btn primary" href="#/stock/entry?item=${product.id}">＋ Stock entry</a>` : ""}</div></div>
      <div class="quick"><div class="tile"><b class="big ${balance < 0 ? "neg" : ""}">${qtyFmt(balance)}</b><span>${h(product.uom || "")} in stock now</span></div></div>
      <div class="scroll"><table class="grid">
        <tr><th>Date</th><th>What</th><th>Ref</th><th>Party / note</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th></tr>
        ${rows.map((r) => `<tr ${r.href ? `class="click" data-href="${r.href}"` : ""}><td>${dmy(r.day)}</td><td>${h(r.kind)}</td><td>${h(r.ref)}</td><td>${h(r.party)}</td>
          <td class="num">${r.qty > 0 ? qtyFmt(r.qty) : ""}</td><td class="num">${r.qty < 0 ? qtyFmt(-r.qty) : ""}</td><td class="num"><b>${qtyFmt(r.balance)}</b></td></tr>`).join("")
          || '<tr><td colspan="7" class="muted">No movement yet.</td></tr>'}
      </table></div>`);
  }

  async function stockMoves() {
    const { rows } = await api("GET", "/api/stock/moves");
    const editable = can("stock", "edit");
    layout(`
      <div class="head"><h1>Stock entries made</h1>
        <div class="actions"><a class="btn" href="#/stock">← Stock</a>${editable ? '<a class="btn primary" href="#/stock/entry">＋ Stock entry</a>' : ""}</div></div>
      <div class="scroll"><table class="grid">
        <tr><th>Date</th><th>Entry</th><th>Ref</th><th>Items (qty)</th><th>Note</th><th>By</th>${editable ? "<th></th>" : ""}</tr>
        ${rows.map((r) => `<tr><td>${dmy(r.move_date)}</td><td>${h(r.kind || "Consumed")}</td><td>${h(r.ref)}</td><td>${h(r.items)}</td><td>${h(r.notes)}</td><td>${h(r.by_user)}</td>
          ${editable ? `<td><button class="btn small" data-del="${h(r.batch)}">Delete</button></td>` : ""}</tr>`).join("")
          || `<tr><td colspan="7" class="muted">No entries yet.</td></tr>`}
      </table></div>`);
    $$("[data-del]").forEach((b) => confirmButton(b, async () => {
      await api("DELETE", `/api/stock/batch/${b.dataset.del}`); flash("Entry deleted."); route();
    }));
  }

  async function stockEntry() {
    if (!can("stock", "edit")) return ctx.forbidden();
    const [{ rows: items }, { rows: bom }] = await Promise.all([api("GET", "/api/stock"), api("GET", "/api/bom")]);
    const pre = params().get("item");
    const opts = (sel, filter = () => true) => `<option value="">— pick item —</option>` + items.filter(filter)
      .map((p) => `<option value="${p.id}" ${String(sel) === String(p.id) ? "selected" : ""}>${h(p.code)} · ${h(p.name)} (${qtyFmt(p.balance)} ${h(p.uom || "")})</option>`).join("");
    const row = (sel, filter, qty = "") => `<tr><td><select name="product_id" class="prod wide">${opts(sel, filter)}</select></td>
      <td><input name="qty" inputmode="decimal" class="qty" value="${qty}"></td><td><button type="button" class="rm" title="Remove">✕</button></td></tr>`;
    layout(`
      <div class="head"><h1>Stock entry</h1><div class="actions"><a class="btn" href="#/stock">← Stock</a></div></div>
      <div id="err"></div>
      <form id="f" class="card">
        <div class="kinds">${KINDS.map(([k, t, s], i) => `<label class="kind"><input type="radio" name="kind" value="${k}" ${i === 0 ? "checked" : ""}><b>${t}</b><small>${s}</small></label>`).join("")}</div>
        <div class="form-grid">
          <label>Date <input type="date" name="date" value="${today()}" required></label>
          <label>Reference <input name="ref" placeholder="e.g. job card, slip no"></label>
          <label>Note <input name="notes"></label>
        </div>
        <h3 id="t1">Items</h3>
        <table class="lines short"><thead><tr><th>Item</th><th>Qty</th><th></th></tr></thead><tbody id="l1">${row(pre)}${row()}</tbody></table>
        <button type="button" class="btn small" id="add1">＋ Add line</button>
        <div id="cons" hidden>
          <h3>Raw material / child parts used <small class="muted">(taken out of stock)</small></h3>
          <p class="muted small" id="bomnote" hidden>Worked out from each product's "material per piece". You can change the quantities.</p>
          <table class="lines short"><thead><tr><th>Item</th><th>Qty used</th><th></th></tr></thead><tbody id="l2">${row(null, (p) => p.category !== "FG")}</tbody></table>
          <button type="button" class="btn small" id="add2">＋ Add line</button>
        </div>
        <div class="buttons"><button class="btn primary">Save entry</button><a class="btn" href="#/stock">Cancel</a></div>
      </form>`);
    const titles = { Opening: "Items and quantity in stock", Production: "Items made", Issue: "Items taken out", Adjustment: "Items and correction (+ or −)" };
    const sync = () => {
      const k = $("#f").kind.value;
      $("#cons").hidden = k !== "Production";
      $("#t1").textContent = titles[k];
      $$(".kind").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
    };
    $$("input[name=kind]").forEach((r) => (r.onchange = sync)); sync();
    $("#add1").onclick = () => $("#l1").insertAdjacentHTML("beforeend", row());
    $("#add2").onclick = () => $("#l2").insertAdjacentHTML("beforeend", row(null, (p) => p.category !== "FG"));
    // Production: work out material used from each product's material per piece.
    const fillConsume = () => {
      if ($("#f").kind.value !== "Production") return;
      const need = new Map();
      for (const l of read($("#l1"))) for (const b of bom.filter((b) => String(b.product_id) === String(l.product_id)))
        need.set(b.component_id, (need.get(b.component_id) || 0) + Number(b.qty_per) * parseFloat(l.qty || 0));
      if (!need.size) return;
      $("#l2").innerHTML = [...need].map(([id, q]) => row(id, (p) => p.category !== "FG", +q.toFixed(3))).join("");
      $("#bomnote").hidden = false;
    };
    $("#l1").addEventListener("input", fillConsume);
    $("#l1").addEventListener("change", fillConsume);
    $$("input[name=kind]").forEach((r) => r.addEventListener("change", fillConsume));
    $("#f").addEventListener("click", (e) => { if (e.target.classList.contains("rm")) e.target.closest("tr").remove(); });
    const read = (tb) => $$("tr", tb).map((tr) => ({ product_id: $("[name=product_id]", tr).value, qty: $("[name=qty]", tr).value })).filter((l) => l.product_id && l.qty);
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, btn = $("button.primary", f);
      busy(btn, true, "Saving…");
      try {
        await api("POST", "/api/stock/move", { kind: f.kind.value, date: f.date.value, ref: f.ref.value, notes: f.notes.value, lines: read($("#l1")), consume: read($("#l2")) });
        flash("Stock entry saved.");
        location.hash = "#/stock";
      } catch (err) { $("#err").innerHTML = errorBox([err.message]); busy(btn, false); scrollTo(0, 0); }
    };
  }

  // ============================================================== SALES REGISTER
  async function salesRegister() {
    const p = params();
    const from = p.get("from") || fyStart(), to = p.get("to") || today();
    const seg = p.get("segment") || "";
    const { rows } = await api("GET", "/api/reports/sales?" + new URLSearchParams({ from, to, segment: seg }));
    const sum = (list, k) => r2(list.reduce((t, r) => t + Number(r[k] || 0), 0));
    const group = (key) => {
      const m = new Map();
      for (const r of rows) { const g = m.get(r[key]) || []; g.push(r); m.set(r[key], g); }
      return [...m.entries()].map(([k, list]) => ({ key: k, n: list.length, subtotal: sum(list, "subtotal"), gst: r2(sum(list, "cgst") + sum(list, "sgst") + sum(list, "igst")), total: sum(list, "total") }));
    };
    const byMonth = group("month");
    const byCust = group("customer").sort((a, b) => b.total - a.total);
    const tot = { subtotal: sum(rows, "subtotal"), cgst: sum(rows, "cgst"), sgst: sum(rows, "sgst"), igst: sum(rows, "igst"), total: sum(rows, "total") };
    const view = p.get("view") || "month";
    const tabs = [["month", "By month"], ["customer", "By customer"], ["invoices", "All invoices"]];
    const qsFor = (v) => "#/sales-register?" + new URLSearchParams({ from, to, view: v, segment: seg });
    let table;
    if (view === "invoices") {
      table = `<tr><th>Invoice No</th><th>Date</th><th>Customer</th><th>GSTIN</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th><th class="num">Total</th></tr>
        ${rows.map((r) => `<tr class="click" data-href="#/invoices/${r.id}"><td><b>${h(r.inv_no)}</b></td><td>${dmy(r.inv_date)}</td><td>${h(r.customer)}</td><td>${h(r.gstin)}</td>
          <td class="num">${money(r.subtotal)}</td><td class="num">${money(r.cgst)}</td><td class="num">${money(r.sgst)}</td><td class="num">${money(r.igst)}</td><td class="num">${money(r.total)}</td></tr>`).join("")}
        <tr class="tot"><td colspan="4">Total</td><td class="num">${money(tot.subtotal)}</td><td class="num">${money(tot.cgst)}</td><td class="num">${money(tot.sgst)}</td><td class="num">${money(tot.igst)}</td><td class="num">${money(tot.total)}</td></tr>`;
    } else {
      const list = view === "customer" ? byCust : byMonth;
      table = `<tr><th>${view === "customer" ? "Customer" : "Month"}</th><th class="num">Invoices</th><th class="num">Taxable value</th><th class="num">GST</th><th class="num">Total</th></tr>
        ${list.map((g) => `<tr><td><b>${h(view === "customer" ? g.key : monthName(g.key))}</b></td><td class="num">${g.n}</td><td class="num">${money(g.subtotal)}</td><td class="num">${money(g.gst)}</td><td class="num">${money(g.total)}</td></tr>`).join("")}
        <tr class="tot"><td>Total</td><td class="num">${rows.length}</td><td class="num">${money(tot.subtotal)}</td><td class="num">${money(r2(tot.cgst + tot.sgst + tot.igst))}</td><td class="num">${money(tot.total)}</td></tr>`;
    }
    layout(`
      <div class="head"><h1>Sales Register</h1>
        <div class="actions"><button class="btn" id="exx">⬇ Excel</button><button class="btn" id="exc">⬇ CSV</button></div></div>
      <form class="filters" id="flt">
        <label class="inline">From <input type="date" name="from" value="${from}"></label>
        <label class="inline">To <input type="date" name="to" value="${to}"></label>
        <input type="hidden" name="view" value="${view}">
        <select name="segment"><option value="">All (Regular + NPD)</option><option value="Regular" ${seg === "Regular" ? "selected" : ""}>Regular production</option><option value="NPD" ${seg === "NPD" ? "selected" : ""}>NPD</option></select>
        <button class="btn">Show</button>
      </form>
      <div class="quick">
        <div class="tile"><b class="big">${rows.length}</b><span>Invoices</span></div>
        <div class="tile"><b class="big">₹ ${money(tot.subtotal)}</b><span>Taxable value</span></div>
        <div class="tile"><b class="big">₹ ${money(r2(tot.cgst + tot.sgst + tot.igst))}</b><span>GST (CGST ${money(tot.cgst)} · SGST ${money(tot.sgst)} · IGST ${money(tot.igst)})</span></div>
        <div class="tile"><b class="big">₹ ${money(tot.total)}</b><span>Total sales</span></div>
      </div>
      <div class="tabs">${tabs.map(([k, t]) => `<a href="${qsFor(k)}" class="${view === k ? "on" : ""}">${t}</a>`).join("")}</div>
      ${rows.length ? `<div class="scroll"><table class="grid">${table}</table></div>` : '<p class="muted">No invoices in these dates.</p>'}`);
    $("#flt").onsubmit = (e) => { e.preventDefault(); location.hash = "#/sales-register?" + new URLSearchParams(new FormData(e.target)); };
    const exp = (fmt) => saveSheets(`sales_register_${from}_to_${to}.${fmt}`, [
      ["Invoices", [["Invoice No", "Date", "Customer", "GSTIN", "PO No", "Taxable Value", "CGST", "SGST", "IGST", "Total"],
        ...rows.map((r) => [r.inv_no, dmy(r.inv_date), r.customer, r.gstin, r.po_no, Number(r.subtotal), Number(r.cgst), Number(r.sgst), Number(r.igst), Number(r.total)]),
        ["Total", "", "", "", "", tot.subtotal, tot.cgst, tot.sgst, tot.igst, tot.total]]],
      ["By month", [["Month", "Invoices", "Taxable Value", "GST", "Total"], ...byMonth.map((g) => [monthName(g.key), g.n, g.subtotal, g.gst, g.total])]],
      ["By customer", [["Customer", "Invoices", "Taxable Value", "GST", "Total"], ...byCust.map((g) => [g.key, g.n, g.subtotal, g.gst, g.total])]],
    ], fmt);
    $("#exx").onclick = () => exp("xlsx");
    $("#exc").onclick = () => exp("csv");
  }

  // ============================================================== ACCOUNTS
  async function accounts() {
    const tab = params().get("tab") === "pay" ? "pay" : "recv";
    const d = await api("GET", "/api/accounts/summary");
    const list = tab === "pay" ? d.payable : d.receivable;
    const dir = tab === "pay" ? "out" : "in";
    const total = (l) => r2(l.reduce((t, r) => t + Math.max(0, Number(r.balance)), 0));
    const editable = can("accounts", "edit");
    layout(`
      <div class="head"><h1>Accounts</h1>
        <div class="actions">
          ${editable ? `<a class="btn primary" href="#/payments/new?dir=in">＋ Payment received</a><a class="btn primary" href="#/payments/new?dir=out">＋ Payment made</a>` : ""}
          <a class="btn" href="#/payments">📋 All payments</a><a class="btn" href="#/bank">🏦 Bank statement</a>
          <button class="btn" id="exx">⬇ Excel</button></div></div>
      <div class="quick">
        <a class="tile ${tab === "recv" ? "sel" : ""}" href="#/accounts"><b class="big">₹ ${money(total(d.receivable))}</b><span>To collect from customers</span></a>
        <a class="tile ${tab === "pay" ? "sel" : ""}" href="#/accounts?tab=pay"><b class="big">₹ ${money(total(d.payable))}</b><span>To pay to vendors</span></a>
      </div>
      <div class="tabs"><a href="#/accounts" class="${tab === "recv" ? "on" : ""}">Customers (receivable)</a><a href="#/accounts?tab=pay" class="${tab === "pay" ? "on" : ""}">Vendors (payable)</a></div>
      <div class="scroll"><table class="grid">
        <tr><th>${tab === "pay" ? "Vendor" : "Customer"}</th><th>Last invoice</th><th class="num">Invoiced</th><th class="num">${tab === "pay" ? "Paid" : "Received"}</th><th class="num">Balance</th></tr>
        ${list.map((r) => `<tr class="click" data-href="#/accounts/${dir}/${r.id}"><td><b>${h(r.name)}</b> <span class="muted small">${h(r.code)}</span></td><td>${dmy(r.last_bill)}</td>
          <td class="num">${money(r.billed)}</td><td class="num">${money(r.settled)}</td><td class="num"><b class="${Number(r.balance) < 0 ? "neg" : ""}">${money(r.balance)}</b></td></tr>`).join("")
          || `<tr><td colspan="5" class="muted">Nothing yet. ${tab === "pay" ? "Vendor invoices" : "Sales invoices"} and payments will show here.</td></tr>`}
      </table></div>`);
    $("#exx").onclick = () => saveSheets(`outstanding_${today()}.xlsx`, [
      ["Receivable", [["Customer Code", "Customer", "Last Invoice", "Invoiced", "Received", "Balance"], ...d.receivable.map((r) => [r.code, r.name, dmy(r.last_bill), Number(r.billed), Number(r.settled), Number(r.balance)])]],
      ["Payable", [["Vendor Code", "Vendor", "Last Invoice", "Invoiced", "Paid", "Balance"], ...d.payable.map((r) => [r.code, r.name, dmy(r.last_bill), Number(r.billed), Number(r.settled), Number(r.balance)])]],
    ]);
  }

  async function statement(dir, id) {
    const { party, rows, balance, bills, advance } = await api("GET", `/api/accounts/statement/${dir}/${id}`);
    const editable = can("accounts", "edit");
    layout(`
      <div class="head"><h1>${h(party.name)} <small>${h(party.code)}</small></h1>
        <div class="actions"><a class="btn" href="#/accounts${dir === "out" ? "?tab=pay" : ""}">← Accounts</a>
          ${editable ? `<a class="btn primary" href="#/payments/new?dir=${dir}&party=${party.id}">＋ ${dir === "in" ? "Payment received" : "Payment made"}</a>` : ""}
          <button class="btn" id="exx">⬇ Excel</button></div></div>
      <div class="quick"><div class="tile"><b class="big ${balance < 0 ? "neg" : ""}">₹ ${money(balance)}</b>
        <span>${balance >= 0 ? (dir === "in" ? "Customer has to pay us" : "We have to pay") : (dir === "in" ? "Advance received from customer" : "Advance paid to vendor")}</span></div>
        ${party.payment_terms ? `<div class="tile"><b>${h(party.payment_terms)}</b><span>Payment terms</span></div>` : ""}</div>
      <div class="scroll"><table class="grid">
        <tr><th>Date</th><th>Entry</th><th>Ref</th><th>Note</th><th class="num">Invoice</th><th class="num">${dir === "in" ? "Received" : "Paid"}</th><th class="num">Balance</th></tr>
        ${rows.map((r) => `<tr ${r.href ? `class="click" data-href="${r.href}"` : ""}><td>${dmy(r.day)}</td><td>${h(r.kind)}</td><td>${h(r.ref)}</td><td>${h(r.notes)}</td>
          <td class="num">${Number(r.debit) ? money(r.debit) : ""}</td><td class="num">${Number(r.credit) ? money(r.credit) : ""}</td><td class="num"><b>${money(r.balance)}</b></td></tr>`).join("")
          || '<tr><td colspan="7" class="muted">No entries yet.</td></tr>'}
      </table></div>
      <h2>${dir === "in" ? "Invoice" : "Bill"}-wise status</h2>
      <p class="muted small">Payments tied to a ${dir === "in" ? "invoice" : "bill"} count there first; the rest is used for the oldest open ones.${advance > 0.5 ? ` Advance not yet used: <b>₹ ${money(advance)}</b>.` : ""}</p>
      <div class="scroll"><table class="grid">
        <tr><th>${dir === "in" ? "Invoice" : "Bill"}</th><th>Date</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th>${editable ? "<th></th>" : ""}</tr>
        ${bills.map((b) => `<tr><td><a href="${dir === "in" ? `#/invoices/${b.id}` : `#/d/vendor_invoice/${b.id}`}"><b>${h(b.ref)}</b></a></td><td>${dmy(b.day)}</td>
          <td class="num">${money(b.total)}</td><td class="num">${b.paid ? money(b.paid) : ""}</td><td class="num"><b>${b.balance > 0.5 ? money(b.balance) : ""}</b></td>
          <td><span class="pill ${b.pay_status === "Paid" ? "ok" : b.pay_status === "Part paid" ? "warn" : ""}">${h(b.pay_status)}</span></td>
          ${editable ? `<td>${b.balance > 0.5 ? `<a class="btn small" href="#/payments/new?dir=${dir}&party=${party.id}&bill=${b.id}&ref=${encodeURIComponent(b.ref)}">Pay</a>` : ""}</td>` : ""}</tr>`).join("")
          || `<tr><td colspan="7" class="muted">No ${dir === "in" ? "invoices" : "bills"}.</td></tr>`}
      </table></div>`);
    $("#exx").onclick = () => saveSheets(`statement_${party.code || party.id}.xlsx`, [["Statement", [[party.name], [],
      ["Date", "Entry", "Ref", "Note", "Invoice", dir === "in" ? "Received" : "Paid", "Balance"],
      ...rows.map((r) => [dmy(r.day), r.kind, r.ref, r.notes, Number(r.debit) || "", Number(r.credit) || "", Number(r.balance)])]]]);
  }

  async function payments() {
    const { rows } = await api("GET", "/api/payments");
    const editable = can("accounts", "edit");
    layout(`
      <div class="head"><h1>Payments</h1>
        <div class="actions"><a class="btn" href="#/accounts">← Accounts</a>
          ${editable ? `<a class="btn primary" href="#/payments/new?dir=in">＋ Payment received</a><a class="btn primary" href="#/payments/new?dir=out">＋ Payment made</a>` : ""}</div></div>
      <div class="scroll"><table class="grid">
        <tr><th>Date</th><th>Type</th><th>Party</th><th>Mode</th><th>Reference</th><th class="num">Amount</th><th>Against</th><th>Note</th>${editable ? "<th></th>" : ""}</tr>
        ${rows.map((r) => `<tr class="click" data-href="#/accounts/${r.direction}/${r.party_id}"><td>${dmy(r.pay_date)}</td><td>${r.direction === "in" ? "⬇ Received" : "⬆ Paid"}</td>
          <td>${h(r.party)}</td><td>${h(r.mode)}</td><td>${h(r.reference)}</td><td class="num">${money(r.amount)}</td><td>${h(r.order_ref || r.against || "On account")}</td><td>${h(r.notes)}</td>
          ${editable ? `<td><button class="btn small" data-del="${r.id}">Delete</button></td>` : ""}</tr>`).join("")
          || '<tr><td colspan="9" class="muted">No payments entered yet.</td></tr>'}
      </table></div>`);
    $$("[data-del]").forEach((b) => confirmButton(b, async () => { await api("DELETE", `/api/payments/${b.dataset.del}`); flash("Payment deleted."); route(); }));
  }

  async function paymentForm() {
    if (!can("accounts", "edit")) return ctx.forbidden();
    const p = params();
    const dir = p.get("dir") === "out" ? "out" : "in";
    const opts = await api("GET", "/api/payments/options");
    const parties = dir === "in" ? opts.customers : opts.vendors;
    layout(`
      <div class="head"><h1>${dir === "in" ? "⬇ Payment received from customer" : "⬆ Payment made to vendor"}</h1>
        <div class="actions"><a class="btn" href="#/accounts${dir === "out" ? "?tab=pay" : ""}">← Accounts</a></div></div>
      <div id="err"></div>
      <form id="f" class="card">
        <div class="form-grid">
          <label class="full">${dir === "in" ? "Customer" : "Vendor"} <span class="req">*</span>
            <select name="party_id" required><option value="">— pick —</option>
              ${parties.map((x) => `<option value="${x.id}" ${p.get("party") === String(x.id) ? "selected" : ""}>${h(x.name)} (${h(x.code)})</option>`).join("")}</select></label>
          <label>Date <span class="req">*</span><input type="date" name="pay_date" value="${today()}" required></label>
          <label>Amount (₹) <span class="req">*</span><input name="amount" inputmode="decimal" required value="${h(p.get("amount") || "")}"></label>
          <label>Mode <select name="mode">${["NEFT", "RTGS", "Cheque", "UPI", "Cash", "Other"].map((m) => `<option>${m}</option>`).join("")}</select></label>
          <label>Reference <input name="reference" placeholder="UTR / cheque no"></label>
          <label class="full">Note <input name="notes" value="${p.get("ref") ? `Against ${h(p.get("ref"))}` : ""}"></label>
        </div>
        <div class="seg" id="mode">
          <label class="check inline"><input type="radio" name="pmode" value="bills" ${p.get("order") ? "" : "checked"}> Against ${dir === "in" ? "invoices" : "bills"}</label>
          <label class="check inline"><input type="radio" name="pmode" value="advance" ${p.get("order") ? "checked" : ""}> Advance against ${dir === "in" ? "customer's PO / sales order" : "our purchase order"}</label>
        </div>
        <div id="orderbox" hidden></div>
        <div id="bills"></div>
        <div class="buttons"><button class="btn primary">Save payment</button></div>
      </form>`);
    const form = $("#f");
    let bills = [];
    let amountTyped = !!p.get("amount") && !p.get("bill");
    let manual = !!p.get("bill");
    form.amount.addEventListener("input", () => { amountTyped = true; if (!manual) suggest(); else summary(); });

    // Which open bills does this amount most likely pay? Exact single bill, then a run of oldest bills,
    // then any combination; if nothing adds up exactly, oldest first with the last one part paid.
    const matchBills = (amt) => {
      const open = bills.map((b) => ({ id: b.id, ref: b.ref, bal: b.balance }));
      const near = (x) => Math.abs(x - amt) <= 1;
      const one = open.find((b) => near(b.bal));
      if (one) return { kind: "exact", pick: [{ ...one, use: one.bal }] };
      let run = 0;
      for (let i = 0; i < open.length; i++) {
        run = r2(run + open[i].bal);
        if (near(run)) return { kind: "exact", pick: open.slice(0, i + 1).map((b) => ({ ...b, use: b.bal })) };
        if (run > amt + 1) break;
      }
      let best = null, steps = 0;
      const dfs = (i, sum, chosen) => {
        if (best || ++steps > 200000) return;
        if (near(sum) && chosen.length) { best = chosen.slice(); return; }
        if (sum > amt + 1 || i >= open.length) return;
        chosen.push(open[i]); dfs(i + 1, sum + open[i].bal, chosen); chosen.pop();
        dfs(i + 1, sum, chosen);
      };
      if (open.length <= 40) dfs(0, 0, []);
      if (best) return { kind: "exact", pick: best.map((b) => ({ ...b, use: b.bal })) };
      let left = amt;
      const pick = [];
      for (const b of open) { if (left <= 0.005) break; const use = r2(Math.min(left, b.bal)); pick.push({ ...b, use }); left = r2(left - use); }
      return { kind: "oldest", pick, extra: left };
    };
    const applyPick = (pick) => {
      const use = Object.fromEntries(pick.map((b) => [String(b.id), b.use]));
      $$("#bills tr[data-id]").forEach((tr) => {
        const v = use[tr.dataset.id];
        $("[name=pay]", tr).value = v ? v : "";
        $("[name=tick]", tr).checked = !!v;
        tr.classList.toggle("hit", !!v);
      });
      summary();
    };
    const suggest = () => {
      const box = $("#suggest");
      if (!box) return;
      const amt = num(form.amount.value);
      if (!(amt > 0) || !bills.length) { box.innerHTML = ""; if (!manual) applyPick([]); return; }
      const m = matchBills(amt);
      const names = m.pick.map((b) => `${h(b.ref)}${b.use < b.bal - 0.005 ? ` (part ₹ ${money(b.use)})` : ""}`).join(" + ");
      box.innerHTML = m.kind === "exact"
        ? `<div class="flash ok">✓ ₹ ${money(amt)} matches <b>${names}</b> exactly. These are ticked below. Change them if the customer paid other bills.</div>`
        : `<div class="flash warn">No ${dir === "in" ? "invoice" : "bill"} or group adds up to exactly ₹ ${money(amt)}. Suggested, oldest first: <b>${names}</b>${m.extra > 0.5 ? `, and ₹ ${money(m.extra)} kept as advance` : ""}.
            ${dir === "in" ? "If the customer deducted TDS or a debit note, tick the bills yourself." : ""}</div>`;
      applyPick(m.pick);
    };
    const inputs = () => $$("#bills input[name=pay]");
    const tied = () => r2(inputs().reduce((t, i) => t + num(i.value), 0));
    const summary = () => {
      const s = $("#alloc");
      if (!s) return;
      const amt = num(form.amount.value), t = tied(), rest = r2(amt - t);
      s.innerHTML = `Against bills: <b>₹ ${money(t)}</b> · ${rest >= 0 ? `On account (advance): <b>₹ ${money(rest)}</b>` : `<b class="neg">₹ ${money(-rest)} more than the payment amount</b>`}`;
    };
    const syncAmount = () => { if (!amountTyped) form.amount.value = tied() ? tied() : ""; summary(); };
    const loadBills = async () => {
      const party = form.party_id.value;
      if (!party) { $("#bills").innerHTML = ""; return; }
      const r = await api("GET", `/api/bills/${dir}?party=${party}`);
      bills = r.rows.filter((x) => x.balance > 0.5);
      const pre = p.get("bill");
      $("#bills").innerHTML = `
        <h2>Which ${dir === "in" ? "invoices" : "bills"} does this payment settle?</h2>
        ${bills.length ? `<p class="muted small">Tick the ${dir === "in" ? "invoices" : "bills"} being paid. You can pay part of one by changing the amount.
          Anything not tied to a ${dir === "in" ? "invoice" : "bill"} is kept as an advance and used for the oldest open ones.</p>
        <div class="scroll"><table class="grid">
          <tr><th></th><th>${dir === "in" ? "Invoice" : "Bill"}</th><th>Date</th><th class="num">Total</th><th class="num">Paid so far</th><th class="num">Balance</th><th class="num">Pay now</th></tr>
          ${bills.map((x) => `<tr data-id="${x.id}"><td><input type="checkbox" name="tick" ${String(x.id) === pre ? "checked" : ""}></td>
            <td><b>${h(x.ref)}</b></td><td>${dmy(x.day)}</td><td class="num">${money(x.total)}</td><td class="num">${x.paid ? money(x.paid) : ""}</td>
            <td class="num"><b>${money(x.balance)}</b></td>
            <td class="num"><input name="pay" inputmode="decimal" class="qty" value="${String(x.id) === pre ? x.balance : ""}"></td></tr>`).join("")}
        </table></div>
        <div class="buttons"><button type="button" class="btn small" id="oldest">Suggest from the amount</button>
          <button type="button" class="btn small" id="clear">Clear</button></div>`
        : `<p class="muted">No open ${dir === "in" ? "invoices" : "bills"} for this party. The payment will be kept as an advance.</p>`}
        <p id="alloc"></p>`;
      if (bills.length) $("#bills h2").insertAdjacentHTML("afterend", '<div id="suggest"></div>');
      $$("#bills tr[data-id]").forEach((tr) => {
        const x = bills.find((b) => String(b.id) === tr.dataset.id);
        const tick = $("[name=tick]", tr), pay = $("[name=pay]", tr);
        tick.onchange = () => { manual = true; pay.value = tick.checked ? x.balance : ""; syncAmount(); };
        pay.oninput = () => { manual = true; tick.checked = num(pay.value) > 0; syncAmount(); };
      });
      const oldest = $("#oldest");
      if (oldest) oldest.onclick = () => { manual = false; amountTyped = true; suggest(); };
      const clear = $("#clear");
      if (clear) clear.onclick = () => { inputs().forEach((i) => (i.value = "")); $$("#bills [name=tick]").forEach((t) => (t.checked = false)); syncAmount(); };
      if (pre && !amountTyped) syncAmount(); else if (!manual && num(form.amount.value) > 0) suggest(); else summary();
    };
    const advMode = () => form.querySelector("[name=pmode]:checked")?.value === "advance";
    const loadOrders = async () => {
      const box = $("#orderbox");
      box.hidden = !advMode();
      $("#bills").hidden = advMode();
      if (!advMode()) return;
      const party = form.party_id.value;
      if (!party) { box.innerHTML = '<p class="muted">Pick the party first.</p>'; return; }
      const { rows } = await api("GET", `/api/orders/open/${dir}?party=${party}`);
      box.innerHTML = rows.length ? `<label>${dir === "in" ? "Sales order (customer PO)" : "Purchase order"} <span class="req">*</span>
          <select name="order_id" required><option value="">— pick —</option>${rows.map((o) => `<option value="${o.id}" ${p.get("order") === String(o.id) ? "selected" : ""}>${h(o.ref_no)}${o.doc_no && o.doc_no !== o.ref_no ? ` · ${h(o.doc_no)}` : ""}${o.doc_date ? ` · ${dmy(o.doc_date)}` : ""} · ₹ ${money(o.total_amount)} (${h(o.status)})</option>`).join("")}</select></label>
        <p class="muted small">The advance is used automatically for the ${dir === "in" ? "invoices" : "vendor bills"} made from this order. Until then it shows as an advance on the order.</p>`
        : `<p class="muted">No ${dir === "in" ? "sales orders" : "purchase orders"} for this party.</p>`;
    };
    $$("[name=pmode]").forEach((r) => (r.onchange = loadOrders));
    form.party_id.onchange = () => { p.delete("bill"); p.delete("order"); manual = false; loadBills(); loadOrders(); };
    await loadBills();
    await loadOrders();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("button.primary", e.target);
      busy(btn, true, "Saving…");
      try {
        const fd = new FormData(e.target);
        const body = { party_id: fd.get("party_id"), pay_date: fd.get("pay_date"), amount: fd.get("amount"), mode: fd.get("mode"),
          reference: fd.get("reference"), notes: fd.get("notes"), direction: dir, order_id: advMode() ? fd.get("order_id") : null,
          allocations: advMode() ? [] : $$("#bills tr[data-id]").map((tr) => ({ bill_id: Number(tr.dataset.id), amount: num($("[name=pay]", tr).value) })).filter((a) => a.amount > 0) };
        await api("POST", "/api/payments", body);
        flash("Payment saved.");
        location.hash = `#/accounts/${dir}/${body.party_id}`;
      } catch (err) { $("#err").innerHTML = errorBox([err.message]); busy(btn, false); scrollTo(0, 0); }
    };
  }

  // ============================================================== MATERIAL PER PIECE (on the product form)
  async function bomCard(product, editable) {
    const { lines, components } = await api("GET", `/api/bom/${product.id}`);
    const opts = (sel) => '<option value="">— pick item —</option>' + components
      .map((p) => `<option value="${p.id}" ${String(sel) === String(p.id) ? "selected" : ""}>${h(p.code)} · ${h(p.name)} (${h(p.uom || "")})</option>`).join("");
    const row = (l = {}) => `<tr><td><select name="component_id" class="prod wide">${opts(l.component_id)}</select></td>
      <td><input name="qty_per" inputmode="decimal" class="qty" value="${l.qty_per ?? ""}"></td><td class="muted uom">${h(l.uom || "")}</td>
      <td>${editable ? '<button type="button" class="rm" title="Remove">✕</button>' : ""}</td></tr>`;
    $("main").insertAdjacentHTML("beforeend", `
      <form id="bom" class="card"><h2>Material used per piece</h2>
        <p class="muted small">What goes into <b>one ${h(product.uom || "piece")}</b> of this item, e.g. 0.45 MTR of PA12 tube and 2 NOS connectors.
          When Production enters pieces made, the material used is worked out from this.</p>
        <div id="bomerr"></div>
        <fieldset ${editable ? "" : "disabled"}><table class="lines short"><thead><tr><th>Material / part</th><th>Qty per piece</th><th></th><th></th></tr></thead>
          <tbody id="bomlines">${lines.map(row).join("")}${editable || !lines.length ? row() : ""}</tbody></table></fieldset>
        ${editable ? '<button type="button" class="btn small" id="bomadd">＋ Add line</button><div class="buttons"><button class="btn primary">💾 Save material list</button></div>' : ""}
      </form>`);
    if (!editable) return;
    const uomOf = Object.fromEntries(components.map((p) => [p.id, p.uom || ""]));
    $("#bomadd").onclick = () => $("#bomlines").insertAdjacentHTML("beforeend", row());
    $("#bom").addEventListener("click", (e) => { if (e.target.classList.contains("rm")) e.target.closest("tr").remove(); });
    $("#bom").addEventListener("change", (e) => { if (e.target.name === "component_id") $(".uom", e.target.closest("tr")).textContent = uomOf[e.target.value] || ""; });
    $("#bom").onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#bom button.primary");
      busy(btn, true, "Saving…");
      try {
        const body = { lines: $$("#bomlines tr").map((tr) => ({ component_id: $("[name=component_id]", tr).value, qty_per: $("[name=qty_per]", tr).value })) };
        await api("PUT", `/api/bom/${product.id}`, body);
        $("#bomerr").innerHTML = '<div class="flash ok">Material list saved.</div>';
      } catch (err) { $("#bomerr").innerHTML = errorBox([err.message]); }
      busy(btn, false);
    };
  }

  // ============================================================== LOAD OLD RECORDS (Admin)
  async function loadData() {
    if (ctx.S.user.role !== "Admin") return ctx.forbidden();
    layout(`
      <div class="head"><h1>Load old records</h1></div>
      <div class="card">
        <p>Bring in your records from your old billing software, e.g. Vyapar <b>Sale Report</b> and <b>Purchase Report</b> Excel exports.
          Customers, vendors, items, sales invoices, purchase bills and payments are created and linked automatically.</p>
        <p class="muted small">Nothing is saved until you press <b>Load into ERP</b>. Loading the same file again does not create duplicates.</p>
        <label>Excel files (.xls / .xlsx) <input type="file" id="files" multiple accept=".xls,.xlsx,.csv"></label>
      </div>
      <div id="out"></div>`);
    $("#files").onchange = async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      const { readOldRecords } = await import("./loaddata.js");
      const wbs = [];
      for (const f of files) wbs.push({ name: f.name, wb: XLSX.read(await f.arrayBuffer(), { type: "array" }) });
      const { found, bundle } = readOldRecords(XLSX, wbs);
      const B = bundle;
      const sum = (l, k) => l.reduce((t, r) => t + Number(r[k] || 0), 0);
      const cat = (c) => B.products.filter((p) => p.category === c).length;
      $("#out").innerHTML = `
        <div class="card"><h2>What was found</h2>
          <ul class="small">${found.map((f) => `<li>${h(f)}</li>`).join("")}</ul>
          <div class="quick">
            <div class="tile"><b class="big">${B.customers.length}</b><span>Customers</span></div>
            <div class="tile"><b class="big">${B.vendors.length}</b><span>Vendors</span></div>
            <div class="tile"><b class="big">${B.products.length}</b><span>Items (FG ${cat("FG")} · RM ${cat("RM")} · BO ${cat("BO")} · PK ${cat("PK")})</span></div>
            <div class="tile"><b class="big">${B.sales.length}</b><span>Sales invoices · ₹ ${money(sum(B.sales, "total"))}<br>to collect ₹ ${money(sum(B.sales, "balance"))}</span></div>
            <div class="tile"><b class="big">${B.purchases.length}</b><span>Purchase bills · ₹ ${money(sum(B.purchases, "total"))}<br>to pay ₹ ${money(sum(B.purchases, "balance"))}</span></div>
          </div>
          ${B.sales.length ? `<p class="small">Invoice numbers become <b>${h(B.sales[0].inv_no)}</b> … <b>${h(B.sales[B.sales.length - 1].inv_no)}</b> (old ${h(B.sales[0].old_no)} … ${h(B.sales[B.sales.length - 1].old_no)}). New invoices continue after the last one.</p>` : ""}
          <div class="buttons"><button class="btn primary" id="go">⬆ Load into ERP</button></div>
          <div id="res"></div>
        </div>
        <div class="card"><h2>Customers</h2><div class="scroll"><table class="grid"><tr><th>Name</th><th>GSTIN</th><th>State</th><th>Phone</th></tr>
          ${B.customers.map((p) => `<tr><td>${h(p.name)}</td><td>${h(p.gstin)}</td><td>${h(p.state)}</td><td>${h(p.phone)}</td></tr>`).join("")}</table></div>
        <h2>Vendors</h2><div class="scroll"><table class="grid"><tr><th>Name</th><th>GSTIN</th><th>State</th><th>Phone</th></tr>
          ${B.vendors.map((p) => `<tr><td>${h(p.name)}</td><td>${h(p.gstin)}</td><td>${h(p.state)}</td><td>${h(p.phone)}</td></tr>`).join("")}</table></div>
        <h2>Items</h2><div class="scroll"><table class="grid"><tr><th>Cat</th><th>Name</th><th>Customer Code</th><th>Drawing No</th><th>UOM</th><th>HSN</th><th class="num">Rate</th></tr>
          ${B.products.map((p) => `<tr><td>${h(p.category)}</td><td>${h(p.name)}</td><td>${h(p.customer_part_no)}</td><td>${h(p.drawing_no)}</td><td>${h(p.uom)}</td><td>${h(p.hsn)}</td>
            <td class="num">${money(p.sale_rate ?? p.purchase_rate)}</td></tr>`).join("")}</table></div></div>`;
      $("#go").onclick = async () => {
        const btn = $("#go");
        busy(btn, true, "Loading… please wait");
        try {
          const { done } = await api("POST", "/api/admin/load", B);
          $("#res").innerHTML = `<div class="flash ok">Loaded: ${done.customers} new customers, ${done.vendors} new vendors, ${done.products} new items,
            ${done.sales} sales invoices, ${done.purchases} purchase bills, ${done.payments} payments.${done.skipped ? ` ${done.skipped} were already in the ERP and were skipped.` : ""}
            <br><a href="#/accounts">See Accounts</a> · <a href="#/sales-register">Sales Register</a> · <a href="#/m/customers">Customers</a></div>`;
          btn.remove();
        } catch (err) { $("#res").innerHTML = errorBox([err.message]); busy(btn, false); }
      };
    };
  }

  return { loadData, bomCard, stockList, stockItem, stockMoves, stockEntry, salesRegister, accounts, statement, payments, paymentForm };
}
