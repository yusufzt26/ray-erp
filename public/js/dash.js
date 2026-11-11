// Department dashboards: Admin overview, Sales, Purchase, Store.
import { COLORS, bars, columns, donut, monthLabel, short } from "./charts.js";
import { PRODUCT_CATEGORIES } from "./fields.js";

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rs = (n) => "₹ " + short(n);
const qty = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const dmy = (iso) => (iso ? iso.split("-").reverse().join("/") : "");

function kpi(label, value, note = "", tone = "", href = "") {
  const tag = href ? "a" : "div";
  return `<${tag} class="kpi ${tone}" ${href ? `href="${href}"` : ""}><span>${h(label)}</span><b>${value}</b>${note ? `<small>${note}</small>` : ""}</${tag}>`;
}
function change(now, before) {
  if (!before) return now ? "new this month" : "";
  const p = Math.round(((now - before) / before) * 100);
  return `<span class="${p >= 0 ? "up" : "down"}">${p >= 0 ? "▲" : "▼"} ${Math.abs(p)}%</span> vs last month`;
}
const panel = (title, body, cls = "", link = "") =>
  `<section class="panel ${cls}"><div class="ph"><h3>${h(title)}</h3>${link}</div>${body}</section>`;
const agingBars = (a, color) => bars(Object.entries(a || {}).map(([label, value]) => ({ label, value })), { color, fmt: (v) => rs(v), empty: "Nothing outstanding." });
const partyTable = (rows, dir) => rows.length ? `<div class="scroll"><table class="grid mini"><tr><th>Party</th><th class="num">Outstanding</th><th class="num">Oldest</th></tr>
  ${rows.map((r) => `<tr class="click" data-href="#/accounts/${dir}/${r.id}"><td>${h(r.name)}</td><td class="num">${rs(r.due)}</td>
    <td class="num ${r.oldest > 60 ? "neg" : ""}">${r.oldest} days</td></tr>`).join("")}</table></div>` : '<p class="muted small">Nothing outstanding.</p>';

export const DASHBOARDS = {
  admin: { label: "Overview", icon: "🏢" },
  sales: { label: "Sales", icon: "📈", perm: "sales_invoice" },
  purchase: { label: "Purchase", icon: "🛒", perm: "vendor_invoice" },
  store: { label: "Store", icon: "📦", perm: "stock" },
};
export const defaultDash = (role) => ({ Admin: "admin", Sales: "sales", Purchaser: "purchase", Store: "store", Production: "store" })[role] || "sales";

function stockParts(stock) {
  const fg = stock.filter((s) => s.category === "FG" || s.category === "SA");
  const rm = stock.filter((s) => s.category === "RM");
  const short_ = stock.filter((s) => s.balance <= 0 && (s.category !== "FG" || s.balance < 0));
  return { fg, rm, short_ };
}

export function renderDash(view, d) {
  const L = d.months.map(monthLabel);
  if (view === "admin") {
    const { short_ } = stockParts(d.stock);
    const overdue = (d.recvAging["61-90 days"] || 0) + (d.recvAging["Over 90 days"] || 0);
    return `
      <div class="kpis">
        ${kpi("Sales this month", rs(d.salesThisMonth), change(d.salesThisMonth, d.salesLastMonth), "", "#/sales-register")}
        ${kpi("Sales this year (FY)", rs(d.salesFY), `${dmy(d.fyStart)} to today, before GST`, "", "#/sales-register")}
        ${kpi("To collect", rs(d.toCollect), overdue ? `${rs(overdue)} older than 60 days` : "nothing older than 60 days", overdue ? "warn" : "", "#/accounts")}
        ${kpi("To pay", rs(d.toPay), "to vendors", "", "#/accounts?tab=pay")}
        ${kpi("Purchases this year", rs(d.purchFY), "before GST", "", "#/d/vendor_invoice")}
        ${kpi("Stock alerts", short_.length, "items at zero or below", short_.length ? "warn" : "", "#/stock")}
      </div>
      <div class="dgrid">
        ${panel("Sales vs purchases, last 12 months", columns(L, [{ name: "Sales", values: d.salesByMonth, color: COLORS[0] }, { name: "Purchases", values: d.purchByMonth, color: COLORS[1] }]), "wide")}
        ${panel("Money to collect, by age", agingBars(d.recvAging, COLORS[0]), "", '<a href="#/accounts">Accounts →</a>')}
        ${panel("Top customers this year", donut(d.topCustomers.map((r) => ({ label: r.label, value: Number(r.value) })), { fmt: rs }))}
        ${panel("Who owes the most", partyTable(d.recvParties.slice(0, 6), "in"))}
        ${panel("Money to pay, by age", agingBars(d.payAging, COLORS[1]), "", '<a href="#/accounts?tab=pay">Accounts →</a>')}
      </div>
      <p class="muted small">${d.counts.customers} customers · ${d.counts.vendors} vendors · ${d.counts.products} items · ${d.users} users</p>`;
  }
  if (view === "sales") {
    return `
      <div class="kpis">
        ${kpi("Sales this month", rs(d.salesThisMonth), change(d.salesThisMonth, d.salesLastMonth), "", "#/sales-register")}
        ${kpi("Invoices this month", d.invoicesThisMonth, "", "", "#/invoices")}
        ${kpi("Sales this year (FY)", rs(d.salesFY), "before GST", "", "#/sales-register")}
        ${kpi("Open customer POs", d.openPOs, "waiting to dispatch", d.openPOs ? "info" : "", "#/d/customer_po")}
        ${kpi("To collect", rs(d.toCollect), `received ${rs(d.receivedThisMonth)} this month`, "", "#/accounts")}
      </div>
      <div class="dgrid">
        ${panel("Sales by month (before GST)", columns(L, [{ name: "Sales", values: d.salesByMonth, color: COLORS[0] }]), "wide", '<a href="#/sales-register">Register →</a>')}
        ${panel("Top customers this year", bars(d.topCustomers.map((r) => ({ label: r.label, value: Number(r.value), sub: `${r.n} invoices` })), { fmt: rs }))}
        ${panel("Top items this year", bars(d.topItems.map((r) => ({ label: r.label, value: Number(r.value), sub: `${qty(r.qty)} pcs` })), { color: COLORS[2], fmt: rs }))}
        ${panel("Money to collect, by age", agingBars(d.recvAging, COLORS[0]))}
        ${panel("Follow up for payment", partyTable(d.recvParties, "in"))}
      </div>`;
  }
  if (view === "purchase") {
    const catName = (c) => (PRODUCT_CATEGORIES[c] ? `${c} - ${PRODUCT_CATEGORIES[c]}` : "Tools, fixtures & others");
    return `
      <div class="kpis">
        ${kpi("Purchases this month", rs(d.purchThisMonth), "before GST", "", "#/d/vendor_invoice")}
        ${kpi("Bills this month", d.billsThisMonth, "", "", "#/d/vendor_invoice")}
        ${kpi("Purchases this year (FY)", rs(d.purchFY), "before GST")}
        ${kpi("To pay vendors", rs(d.toPay), "", d.toPay ? "info" : "", "#/accounts?tab=pay")}
      </div>
      <div class="dgrid">
        ${panel("Purchases by month (before GST)", columns(L, [{ name: "Purchases", values: d.purchByMonth, color: COLORS[1] }]), "wide")}
        ${panel("Spend by type this year", donut(d.spendByCategory.map((r) => ({ label: catName(r.label), value: Number(r.value) })), { fmt: rs }))}
        ${panel("Top vendors this year", bars(d.topVendors.map((r) => ({ label: r.label, value: Number(r.value) })), { color: COLORS[1], fmt: rs }))}
        ${panel("Money to pay, by age", agingBars(d.payAging, COLORS[1]))}
        ${panel("Latest vendor bills", d.recentBills.length ? `<div class="scroll"><table class="grid mini"><tr><th>Date</th><th>Vendor</th><th>Bill No</th><th class="num">Total</th></tr>
          ${d.recentBills.map((r) => `<tr class="click" data-href="#/d/vendor_invoice/${r.id}"><td>${dmy(r.doc_date)}</td><td>${h(r.party_name)}</td><td>${h(r.doc_no)}</td><td class="num">${rs(r.total_amount)}</td></tr>`).join("")}</table></div>`
          : '<p class="muted small">No bills yet.</p>', "wide", '<a href="#/d/vendor_invoice/upload">⬆ Upload bill</a>')}
      </div>`;
  }
  // store
  const { fg, rm, short_ } = stockParts(d.stock);
  const top = (list) => list.slice().sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)).slice(0, 8)
    .map((s) => ({ label: `${s.code} · ${s.name}`, value: s.balance, sub: s.uom }));
  return `
    <div class="kpis">
      ${kpi("Items in stock", d.stock.filter((s) => s.balance > 0).length, `of ${d.stock.length} items`, "", "#/stock?only=instock")}
      ${kpi("Need attention", short_.length, "items at zero or minus", short_.length ? "warn" : "", "#/stock")}
      ${kpi("Dispatched this month", qty(d.dispatchByMonth[11]), "pieces on sales invoices")}
      ${kpi("Made this month", qty(d.productionByMonth[11]), "from production entries", "", "#/stock/moves")}
      ${kpi("Vendor bills received", d.receiptsThisMonth, "this month", "", "#/d/vendor_invoice")}
    </div>
    <div class="dgrid">
      ${panel("Made vs dispatched (pieces), last 12 months", columns(L, [{ name: "Made", values: d.productionByMonth, color: COLORS[2] }, { name: "Dispatched", values: d.dispatchByMonth, color: COLORS[0] }], { fmt: qty }), "wide")}
      ${panel("Finished goods stock", bars(top(fg), { color: COLORS[2], fmt: qty, empty: "No finished goods yet." }), "", '<a href="#/stock?cat=FG">All →</a>')}
      ${panel("Raw material (tube) in stock", bars(top(rm), { color: COLORS[3], fmt: qty, empty: "No raw material yet." }), "", '<a href="#/stock?cat=RM">All →</a>')}
      ${panel("Needs attention", short_.length ? `<div class="scroll"><table class="grid mini"><tr><th>Item</th><th class="num">Stock</th></tr>
        ${short_.slice(0, 10).map((s) => `<tr class="click" data-href="#/stock/${s.id}"><td>${h(s.code)} · ${h(s.name)}</td><td class="num neg">${qty(s.balance)} ${h(s.uom || "")}</td></tr>`).join("")}</table></div>
        ${short_.length > 10 ? `<p class="muted small">and ${short_.length - 10} more</p>` : ""}` : '<p class="muted small">All good.</p>', "", '<a href="#/stock/entry">＋ Stock entry</a>')}
      ${panel("Latest stock entries", d.recentMoves.length ? `<div class="scroll"><table class="grid mini"><tr><th>Date</th><th>Entry</th><th>Items</th></tr>
        ${d.recentMoves.map((r) => `<tr><td>${dmy(r.move_date)}</td><td>${h(r.kind || "Consumed")}</td><td class="small">${h(r.items)}</td></tr>`).join("")}</table></div>` : '<p class="muted small">No entries yet.</p>')}
    </div>`;
}
