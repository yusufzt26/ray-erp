// Production Plan: the planner lists what to make this week or month; the floor
// presses "+ Done" to log what got finished. Each finished entry also goes into
// stock (product up, material per piece down), so nothing is typed twice.

import { saveSheets } from "./download.js";

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const qtyFmt = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const dmy = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const params = () => new URLSearchParams(location.hash.split("?")[1] || "");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const asDate = (iso) => new Date(iso + "T00:00:00Z");
const isoOf = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => isoOf(new Date(asDate(iso).getTime() + n * 86400e3));
const short = (iso) => { const d = asDate(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
/** ISO week number (weeks start on Monday). */
const weekNo = (iso) => {
  const d = asDate(iso); d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const w1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - w1) / 86400e3 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7);
};
export const periodLabel = (period, start, end) => period === "month"
  ? `${FULL_MONTHS[asDate(start).getUTCMonth()]} ${asDate(start).getUTCFullYear()}`
  : `Week ${weekNo(start)} · ${short(start)} – ${short(end)} ${asDate(end).getUTCFullYear()}`;

/** Where a plan row stands. */
export function rowStatus(l, todayIso) {
  if (l.done >= l.planned_qty) return ["Done", "done"];
  if (l.target_date && l.target_date < todayIso) return ["Late", "late"];
  if (l.done > 0) return ["In progress", "prog"];
  return ["Not started", "none"];
}
const pct = (done, planned) => (planned > 0 ? Math.min(100, Math.round((done / planned) * 100)) : 0);
const bar = (p, tone) => `<span class="pbar ${tone}" title="${p}%"><i style="width:${p}%"></i></span>`;

export function planPages(ctx) {
  const { api, layout, can, flash, $, $$, errorBox, busy } = ctx;
  const route = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
  const isAdmin = () => ctx.S?.user?.role === "Admin";
  /** A button that asks "sure?" on the page (no popup) before doing something that can't be undone. */
  const armed = (b, text) => { if (b.dataset.armed) return true; b.dataset.armed = "1"; b.dataset.orig = b.innerHTML; b.textContent = text; b.classList.add("danger");
    setTimeout(() => { if (b.isConnected && !b.disabled) { delete b.dataset.armed; b.innerHTML = b.dataset.orig; b.classList.remove("danger"); } }, 5000); return false; };
  const boardHref = (period, date) => `#/production?period=${period}&date=${date}`;

  // ============================================================== PRODUCTION (one page)
  // Plan for the week / month on top, one entry bar to log what was made, and every entry of the
  // period underneath (filter, trace, Excel; Admin edits or deletes). Nothing is typed or shown twice.
  const SHIFTS = ["", "A", "B", "C", "General"];

  async function board() {
    const p = params();
    const period = p.get("period") === "month" ? "month" : "week";
    const editable = can("production", "edit");
    const d = await api("GET", "/api/production?" + new URLSearchParams({ period, date: p.get("date") || today() }));
    const [{ rows: entries }, opts] = await Promise.all([
      api("GET", "/api/production/log?" + new URLSearchParams({ from: d.start, to: d.end })),
      editable ? api("GET", "/api/production/options") : Promise.resolve({ products: [] }),
    ]);
    const { plan, lines } = d;
    const word = period === "month" ? "month" : "week";
    const isNow = d.start <= d.today && d.today <= d.end;
    const planned = lines.reduce((t, l) => t + l.planned_qty, 0);
    const done = lines.reduce((t, l) => t + Math.min(l.done, l.planned_qty), 0);
    const late = lines.filter((l) => rowStatus(l, d.today)[1] === "late").length;
    const overall = pct(done, planned);
    const released = plan?.status === "Released";
    const prev = addDays(d.start, -1), next = addDays(d.end, 1);
    const last = (() => { try { return JSON.parse(localStorage.getItem("prod_entry") || "{}"); } catch { return {}; } })();

    // entry bar: plan products first (with what is still to make), then everything else
    const inPlan = new Map(lines.map((l) => [String(l.product_id), l]));
    const prodOpts = '<option value="">— pick product —</option>'
      + (released && lines.length ? `<optgroup label="In this ${word}'s plan">${lines.map((l) => `<option value="${l.product_id}">★ ${h(l.code)} · ${h(l.name)} (to make ${qtyFmt(Math.max(0, l.planned_qty - l.done))})</option>`).join("")}</optgroup>` : "")
      + `<optgroup label="All products">${opts.products.filter((x) => !(released && inPlan.has(String(x.id)))).map((x) => `<option value="${x.id}">${h(x.code)} · ${h(x.name)}</option>`).join("")}</optgroup>`;
    const entryBar = editable ? `<form id="entry" class="card entrybar">
        <div class="ehead"><b>📝 Log production</b><span class="muted small">Part quantities are fine: every entry adds up${released ? ` and counts toward this ${word}'s plan` : ""}. Stock goes up, material per piece comes out.</span></div>
        <div class="efields">
          <label>Date <input type="date" name="date" value="${isNow ? d.today : d.start}" required></label>
          <label>Shift <select name="shift">${SHIFTS.map((s) => `<option value="${s}" ${(last.shift || "") === s ? "selected" : ""}>${s || "—"}</option>`).join("")}</select></label>
          <label>Operator <input name="operator" value="${h(last.operator || "")}" placeholder="optional"></label>
          <label class="grow">Product <select name="product_id" required>${prodOpts}</select></label>
          <label>Qty made <input name="qty" inputmode="decimal" class="qty" required></label>
          <label class="grow">Remarks <input name="remarks" placeholder="optional"></label>
          <button class="btn primary">💾 Save</button>
        </div></form>` : "";

    const rows = lines.map((l, i) => {
      const [st, tone] = rowStatus(l, d.today);
      return `<tr data-line="${l.id}" data-product="${l.product_id}">
        <td class="ln">${i + 1}</td>
        <td><b>${h(l.code)}</b> · ${h(l.name)}${l.notes ? `<div class="muted small">${h(l.notes)}</div>` : ""}</td>
        <td data-label="Target">${dmy(l.target_date)}</td>
        <td data-label="Sales order">${l.order_id ? `<a href="#/d/customer_po/${l.order_id}">${h(l.order_no || "SO")}</a><div class="muted small">${h(l.order_party || "")}</div>` : '<span class="muted">—</span>'}</td>
        <td class="num" data-label="Planned">${qtyFmt(l.planned_qty)} <span class="muted small">${h(l.uom || "")}</span></td>
        <td class="num" data-label="Done"><a href="#entries" class="donecount" title="Show its entries">${qtyFmt(l.done)}</a></td>
        <td class="num" data-label="Balance">${qtyFmt(Math.max(0, l.planned_qty - l.done))}</td>
        <td class="pcell" data-label="Progress">${bar(pct(l.done, l.planned_qty), tone)}<small>${pct(l.done, l.planned_qty)}%</small></td>
        <td data-label="Status"><span class="st ${tone}">${st}</span></td>
        <td class="actcell">${editable && released ? '<button type="button" class="btn small primary plus" title="Log production for this row">＋ Log</button>' : ""}</td>
      </tr>`;
    }).join("");

    const planBlock = !plan ? `<div class="card empty">
        <p><b>No plan for this ${word}.</b> ${editable ? "You can still log production above." : ""}</p>
        ${editable ? `<button class="btn" id="make">＋ Make this ${word}'s plan</button>` : ""}
      </div>` : `
      <div class="overall card">
        <div class="ohead"><span>${isNow ? `This ${word}` : h(periodLabel(period, d.start, d.end))}: <b>${overall}% done</b></span>
          <span class="pill ${released ? "ok" : "warn"}">${released ? "Released" : "Draft"}</span></div>
        ${bar(overall, overall >= 100 ? "done" : late ? "late" : done ? "prog" : "none")}
        <p class="muted small">${qtyFmt(done)} of ${qtyFmt(planned)} planned finished · ${lines.filter((l) => l.done >= l.planned_qty).length} of ${lines.length} rows complete${late ? ` · <b class="neg">${late} late</b>` : ""}</p>
        ${!released ? `<p class="small">${editable ? "Draft: check the rows, then press <b>Release plan</b> so entries count toward it." : "Draft: the planner is still working on this plan."}</p>` : ""}
        ${plan.notes ? `<p class="small">📝 ${h(plan.notes)}</p>` : ""}
      </div>
      <div class="scroll"><table class="grid plan">
        <tr><th>#</th><th>Product</th><th>Target</th><th>Sales order</th><th class="num">Planned</th><th class="num">Done</th><th class="num">Balance</th><th>Progress</th><th>Status</th><th></th></tr>
        ${rows || `<tr><td colspan="10" class="muted">No rows yet. ${editable ? `<a href="#/production/${plan.id}/edit">Add products</a>` : ""}</td></tr>`}
      </table></div>`;

    const entryProducts = [...new Map(entries.map((r) => [String(r.product_id), r])).values()];
    const allPlans = d.others.length ? `<details class="allplans" ${plan ? "" : "open"}><summary>All plans (${d.others.length})</summary><div class="scroll"><table class="grid mini">
        <tr><th>Plan</th><th>Status</th><th class="num">Rows</th><th class="num">Planned</th><th class="num">Done</th><th>Progress</th><th class="num">Late</th>${editable ? "<th></th>" : ""}</tr>
        ${d.others.map((o) => { const op = pct(Number(o.done), Number(o.planned)); return `<tr class="click" data-href="${boardHref(o.period, o.start_date)}">
          <td class="nowrap">${h(periodLabel(o.period, o.start_date, o.end_date))}</td><td>${h(o.status)}</td>
          <td class="num">${o.lines}</td><td class="num">${qtyFmt(o.planned)}</td><td class="num">${qtyFmt(o.done)}</td>
          <td class="pcell">${bar(op, op >= 100 ? "done" : Number(o.late) ? "late" : op ? "prog" : "none")}<small>${op}%</small></td>
          <td class="num ${Number(o.late) ? "neg" : ""}">${o.late}</td>
          ${editable ? `<td class="nowrap"><a class="btn small" href="#/production/${o.id}/edit">✏️ Edit</a>
            ${isAdmin() || !Number(o.done) ? `<button type="button" class="btn small delplan" data-id="${o.id}" data-done="${Number(o.done) ? 1 : 0}">🗑 Delete</button>` : ""}</td>` : ""}</tr>`; }).join("")}</table></div></details>` : "";

    layout(`
      <div class="head"><h1>Production</h1>
        <div class="actions">
          ${plan && editable ? `<a class="btn" href="#/production/${plan.id}/edit">✏️ Edit plan</a>
            ${released ? '<button class="btn" id="draft">↩ Back to draft</button>' : '<button class="btn primary" id="release">✅ Release plan</button>'}` : ""}
        </div></div>
      <div class="planbar">
        <div class="tabs ptabs"><a href="${boardHref("week", isNow || period === "week" ? d.today : d.start)}" class="${period === "week" ? "on" : ""}">Week</a>
          <a href="${boardHref("month", period === "month" ? d.today : d.start)}" class="${period === "month" ? "on" : ""}">Month</a></div>
        <div class="pnav">
          <a class="btn small" href="${boardHref(period, prev)}" title="Previous ${word}">‹</a>
          <b>${h(periodLabel(period, d.start, d.end))}</b>
          <a class="btn small" href="${boardHref(period, next)}" title="Next ${word}">›</a>
          ${isNow ? "" : `<a class="btn small" href="${boardHref(period, d.today)}">This ${word}</a>`}
          <input type="date" id="jump" value="${d.start}" title="Go to a date">
        </div>
      </div>
      ${entryBar}
      ${planBlock}
      <section id="entries">
        <div class="head sub"><h2>Entries this ${word} <small class="muted" id="ecount"></small></h2>
          <div class="actions"><button class="btn small" id="exx">⬇ Excel</button></div></div>
        <form class="filters" id="eflt">
          <select name="product"><option value="">All products</option>${entryProducts.map((r) => `<option value="${r.product_id}">${h(r.code)} · ${h(r.name)}</option>`).join("")}</select>
          <select name="shift"><option value="">All shifts</option>${SHIFTS.filter(Boolean).map((s) => `<option>${s}</option>`).join("")}</select>
          <input name="q" placeholder="Search operator, remarks…">
        </form>
        <div id="elist"></div>
      </section>
      ${allPlans}`);

    // ---- entries list: filtered on the page, no reload
    const shown = () => {
      const f = Object.fromEntries(new FormData($("#eflt")));
      const qq = (f.q || "").toLowerCase();
      return entries.filter((r) => (!f.product || String(r.product_id) === f.product) && (!f.shift || r.shift === f.shift)
        && (!qq || [r.operator, r.remarks, r.code, r.name, r.by_user].join(" ").toLowerCase().includes(qq)));
    };
    const drawEntries = () => {
      const list = shown();
      $("#ecount").textContent = `(${list.length} · ${qtyFmt(list.reduce((t, r) => t + r.qty, 0))} made)`;
      $("#elist").innerHTML = logTable(list);
      wireUndo(list);
    };
    $("#eflt").addEventListener("input", drawEntries);
    $("#eflt").onsubmit = (e) => e.preventDefault();
    drawEntries();
    $("#exx").onclick = () => saveSheets(`production_${d.start}_to_${d.end}.xlsx`, [["Production", [
      ["Date", "Shift", "Item Code", "Product", "Qty", "UOM", "Operator", "Plan", "Sales Order", "Customer", "Remarks", "Material used", "Entered by", "Entered at"],
      ...shown().map((r) => [dmy(r.log_date), r.shift || "", r.code, r.name, r.qty, r.uom || "", r.operator || "", r.plan_start ? `${r.period} ${dmy(r.plan_start)}` : "",
        r.order_no || "", r.order_party || "", r.remarks || "", r.consumed || "", r.by_user || "", r.entered_at || ""])]]], "xlsx");
    const showProduct = (pid) => { $("#eflt").product.value = pid; drawEntries(); $("#entries").scrollIntoView({ behavior: "smooth" }); };
    $$("a.donecount").forEach((a) => (a.onclick = (e) => { e.preventDefault(); showProduct(a.closest("tr").dataset.product); }));

    // ---- one entry form for everything
    $$("button.plus").forEach((b) => (b.onclick = () => {
      const f = $("#entry");
      f.product_id.value = b.closest("tr").dataset.product;
      f.scrollIntoView({ behavior: "smooth", block: "center" });
      f.qty.focus();
    }));
    $("#entry")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target, btn = $("button.primary", f);
      try { localStorage.setItem("prod_entry", JSON.stringify({ shift: f.shift.value, operator: f.operator.value })); } catch { /* private mode */ }
      busy(btn, true, "Saving…");
      try {
        await api("POST", "/api/production/daily", { date: f.date.value, shift: f.shift.value, operator: f.operator.value, auto: true,
          lines: [{ product_id: f.product_id.value, qty: f.qty.value, remarks: f.remarks.value }] });
        flash("Saved and added to stock.");
      } catch (err) { flash(err.message, "error"); }
      route();
    });

    // ---- plan actions
    $("#jump").onchange = (e) => { if (e.target.value) location.hash = boardHref(period, e.target.value); };
    $("#make")?.addEventListener("click", async (e) => {
      busy(e.target, true, "Making…");
      const { id } = await api("POST", "/api/production", { period, date: d.start });
      location.hash = `#/production/${id}/edit`;
    });
    const setStatus = (status, msg) => async (e) => {
      busy(e.target, true, "Saving…");
      try { await api("POST", `/api/production/${plan.id}/status`, { status }); flash(msg); }
      catch (err) { flash(err.message, "error"); }
      route();
    };
    $("#release")?.addEventListener("click", setStatus("Released", "Plan released. Entries now count toward it."));
    $("#draft")?.addEventListener("click", setStatus("Draft", "Plan is back in draft."));
    $$("button.delplan").forEach((b) => (b.onclick = async () => {
      if (!armed(b, b.dataset.done === "1" ? "Delete plan and its entries? Click again" : "Sure? Click again")) return;
      b.disabled = true;
      try {
        const r = await api("DELETE", `/api/production/${b.dataset.id}`);
        flash(r.entries ? `Plan deleted, with its ${r.entries} production ${r.entries === 1 ? "entry" : "entries"} and their stock entries.` : "Plan deleted.");
      } catch (err) { flash(err.message, "error"); }
      route();
    }));
  }

  // ============================================================== EDIT PLAN
  async function edit(id) {
    if (!can("production", "edit")) return ctx.forbidden();
    const [{ plan, lines }, { products, orders }] = await Promise.all([api("GET", `/api/production/${id}`), api("GET", "/api/production/options")]);
    const word = plan.period === "month" ? "month" : "week";
    const back = boardHref(plan.period, plan.start_date);
    const prodOpts = (sel) => '<option value="">— pick product —</option>' + products
      .map((p) => `<option value="${p.id}" ${String(sel) === String(p.id) ? "selected" : ""}>${h(p.code)} · ${h(p.name)}</option>`).join("");
    const orderOpts = (sel) => '<option value="">— none —</option>' + orders
      .map((o) => `<option value="${o.id}" ${String(sel) === String(o.id) ? "selected" : ""}>${h(o.doc_no || "SO #" + o.id)} · ${h(o.party_name || "")}</option>`).join("");
    const row = (l = {}) => `<tr data-id="${l.id || ""}">
      <td><select name="product_id" class="prod wide">${prodOpts(l.product_id)}</select></td>
      <td><input name="planned_qty" inputmode="decimal" class="qty" value="${l.planned_qty ?? ""}"></td>
      <td><input type="date" name="target_date" value="${l.target_date || plan.end_date}"></td>
      <td><select name="order_id">${orderOpts(l.order_id)}</select></td>
      <td><input name="notes" value="${h(l.notes || "")}" placeholder="optional"></td>
      <td class="nowrap">${Number(l.done) > 0 ? `<span class="muted small" title="Finished quantity is logged on this row">${qtyFmt(l.done)} done</span>` : ""}
        ${!(Number(l.done) > 0) || isAdmin() ? `<button type="button" class="rm" title="${Number(l.done) > 0 ? "Remove the row. Its production entries stay in the log and in stock, without a plan." : "Remove"}">✕</button>` : ""}</td></tr>`;
    layout(`
      <div class="head"><h1>${h(plan.period === "month" ? "Monthly" : "Weekly")} plan <small>${h(periodLabel(plan.period, plan.start_date, plan.end_date))}</small></h1>
        <div class="actions"><a class="btn" href="${back}">← Back to board</a></div></div>
      <div id="err"></div>
      <form id="f" class="card">
        <p class="muted small">One row per product: how many to make and by when. Link a sales order if the row is made for one.</p>
        <div class="scroll"><table class="lines planlines"><thead><tr><th>Product</th><th>Planned qty</th><th>Target date</th><th>Sales order</th><th>Note</th><th></th></tr></thead>
          <tbody id="rows">${lines.map(row).join("")}${row()}</tbody></table></div>
        <button type="button" class="btn small" id="add">＋ Add row</button>
        <button type="button" class="btn small" id="copy">⧉ Copy rows from last ${word}</button>
        <label class="full">Note for the floor <textarea name="plan_notes" rows="2">${h(plan.notes || "")}</textarea></label>
        <div class="buttons"><button class="btn primary">💾 Save plan</button><a class="btn" href="${back}">Cancel</a>
          <button type="button" class="btn" id="del" style="margin-left:auto">🗑 Delete plan</button></div>
      </form>`);
    $("#add").onclick = () => $("#rows").insertAdjacentHTML("beforeend", row());
    $("#f").addEventListener("click", (e) => { if (e.target.classList.contains("rm")) e.target.closest("tr").remove(); });
    $("#copy").onclick = async (e) => {
      const prev = await api("GET", "/api/production?" + new URLSearchParams({ period: plan.period, date: addDays(plan.start_date, -1) }));
      if (!prev.lines.length) { e.target.textContent = `No plan last ${word}`; e.target.disabled = true; return; }
      $$("#rows tr").forEach((tr) => { if (!$("[name=product_id]", tr).value) tr.remove(); });
      $("#rows").insertAdjacentHTML("beforeend", prev.lines.map((l) => row({ product_id: l.product_id, planned_qty: l.planned_qty, notes: l.notes })).join(""));
    };
    $("#del").onclick = async (e) => {
      const b = e.target;
      if (!armed(b, lines.some((l) => Number(l.done) > 0) ? "Delete plan and its entries? Click again" : "Sure? Click again")) return;
      try {
        const r = await api("DELETE", `/api/production/${plan.id}`);
        flash(r.entries ? `Plan deleted, with its ${r.entries} production ${r.entries === 1 ? "entry" : "entries"} and their stock entries.` : "Plan deleted.");
        location.hash = back;
      }
      catch (err) { $("#err").innerHTML = errorBox([err.message]); scrollTo(0, 0); }
    };
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("button.primary", e.target);
      const body = {
        notes: e.target.plan_notes.value,
        lines: $$("#rows tr").map((tr) => ({ id: tr.dataset.id, ...Object.fromEntries(["product_id", "planned_qty", "target_date", "order_id", "notes"].map((k) => [k, $(`[name=${k}]`, tr).value])) }))
          .filter((l) => l.product_id),
      };
      busy(btn, true, "Saving…");
      try {
        await api("PUT", `/api/production/${plan.id}`, body);
        flash(plan.status === "Released" ? "Plan saved." : "Plan saved. Press Release plan when it's ready for the floor.");
        location.hash = back;
      } catch (err) { $("#err").innerHTML = errorBox([err.message]); busy(btn, false); scrollTo(0, 0); }
    };
  }

  // ============================================================== PRODUCTION LOG (trace)
  function logTable(rows) {
    const compact = false;
    const editable = can("production", "edit");
    if (!rows.length) return '<p class="muted small">No entries yet.</p>';
    return `<div class="scroll"><table class="grid tracelog">
      <tr><th>Date</th><th>Shift</th><th>Product</th><th class="num">Qty</th><th>Operator</th>${compact ? "" : "<th>Plan</th><th>Sales order</th>"}<th>Remarks</th>${compact ? "" : "<th>Material used</th>"}<th>Entered</th>${editable ? "<th></th>" : ""}</tr>
      ${rows.map((r) => `<tr>
        <td>${dmy(r.log_date)}</td><td>${h(r.shift || "")}</td>
        <td><a href="#" class="tracep" data-p="${r.product_id}" title="Show only this product"><b>${h(r.code)}</b></a> · ${h(r.name)}</td>
        <td class="num"><b>${qtyFmt(r.qty)}</b> <span class="muted small">${h(r.uom || "")}</span></td>
        <td>${h(r.operator || "")}</td>
        ${compact ? "" : `<td>${r.plan_start ? `<a href="#/production?period=${r.period}&date=${r.plan_start}">${r.period === "month" ? "Month" : "Week"} ${dmy(r.plan_start)}</a>` : '<span class="muted">—</span>'}</td>
        <td>${r.order_id ? `<a href="#/d/customer_po/${r.order_id}">${h(r.order_no || "SO")}</a><div class="muted small">${h(r.order_party || "")}</div>` : '<span class="muted">—</span>'}</td>`}
        <td>${h(r.remarks || "")}</td>
        ${compact ? "" : `<td class="small">${h(r.consumed || "")}</td>`}
        <td class="small">${h(r.by_user || "")}<div class="muted">${h(r.entered_at || "")}</div></td>
        ${editable ? `<td class="nowrap">${isAdmin() ? `<button type="button" class="btn small editlog" data-log="${r.id}">✏️ Edit</button>` : ""}<button type="button" class="btn small undo" data-log="${r.id}">${isAdmin() ? "🗑 Delete" : "Undo"}</button></td>` : ""}</tr>`).join("")}
    </table></div>`;
  }
  function wireUndo(rows = []) {
    $$("a.tracep").forEach((a) => (a.onclick = (e) => { e.preventDefault(); const f = $("#eflt"); if (f) { f.product.value = a.dataset.p; f.dispatchEvent(new Event("input")); } }));
    $$("button.editlog").forEach((b) => (b.onclick = () => {
      const r = rows.find((x) => String(x.id) === b.dataset.log), tr = b.closest("tr");
      if (!r) return;
      const cols = tr.children.length;
      tr.outerHTML = `<tr class="editrow" data-log="${r.id}"><td colspan="${cols}"><form class="donef">
        <b>${h(r.code)} · ${h(r.name)}</b>
        <label class="small">Date <input type="date" name="date" value="${r.log_date}" required></label>
        <label class="small">Shift <select name="shift">${SHIFTS.map((s) => `<option value="${s}" ${(r.shift || "") === s ? "selected" : ""}>${s || "—"}</option>`).join("")}</select></label>
        <label class="small">Qty <input name="qty" inputmode="decimal" class="qty" value="${r.qty}" required></label>
        <label class="small">Operator <input name="operator" value="${h(r.operator || "")}"></label>
        <label class="small">Remarks <input name="remarks" value="${h(r.remarks || "")}"></label>
        <button class="btn small primary">Save</button><button type="button" class="btn small cancel">Cancel</button>
        <span class="muted small">Stock is corrected to match.</span></form></td></tr>`;
      const f = $(`tr.editrow[data-log="${r.id}"] form`);
      $(".cancel", f).onclick = () => route();
      f.onsubmit = async (e) => {
        e.preventDefault();
        busy($("button.primary", f), true, "Saving…");
        try { await api("PUT", `/api/production/log/${r.id}`, Object.fromEntries(new FormData(f))); flash("Entry updated, and its stock entry with it."); }
        catch (err) { flash(err.message, "error"); }
        route();
      };
    }));
    $$("button.undo").forEach((b) => (b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Sure? Click again"; b.classList.add("danger"); return; }
      b.disabled = true;
      try { await api("DELETE", `/api/production/log/${b.dataset.log}`); flash("Entry undone. Its stock entry was removed too."); }
      catch (err) { flash(err.message, "error"); }
      route();
    }));
  }

  return { board, edit };
}
