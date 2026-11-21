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

  // ============================================================== BOARD
  async function board() {
    const p = params();
    const period = p.get("period") === "month" ? "month" : "week";
    const d = await api("GET", "/api/production?" + new URLSearchParams({ period, date: p.get("date") || today() }));
    const editable = can("production", "edit");
    const { plan, lines } = d;
    const word = period === "month" ? "month" : "week";
    const isNow = d.start <= d.today && d.today <= d.end;
    const planned = lines.reduce((t, l) => t + l.planned_qty, 0);
    const done = lines.reduce((t, l) => t + Math.min(l.done, l.planned_qty), 0);
    const late = lines.filter((l) => rowStatus(l, d.today)[1] === "late").length;
    const overall = pct(done, planned);
    const released = plan?.status === "Released";
    const prev = addDays(d.start, -1), next = addDays(d.end, 1);

    const rows = lines.map((l, i) => {
      const [st, tone] = rowStatus(l, d.today);
      const bal = Math.max(0, l.planned_qty - l.done);
      return `<tr data-line="${l.id}">
        <td class="ln">${i + 1}</td>
        <td><b>${h(l.code)}</b> · ${h(l.name)}${l.notes ? `<div class="muted small">${h(l.notes)}</div>` : ""}</td>
        <td data-label="Target">${dmy(l.target_date)}</td>
        <td data-label="Sales order">${l.order_id ? `<a href="#/d/customer_po/${l.order_id}">${h(l.order_no || "SO")}</a><div class="muted small">${h(l.order_party || "")}</div>` : '<span class="muted">—</span>'}</td>
        <td class="num" data-label="Planned">${qtyFmt(l.planned_qty)} <span class="muted small">${h(l.uom || "")}</span></td>
        <td class="num" data-label="Done"><a href="#" class="donecount" title="See entries">${qtyFmt(l.done)}</a></td>
        <td class="num" data-label="Balance">${qtyFmt(bal)}</td>
        <td class="pcell" data-label="Progress">${bar(pct(l.done, l.planned_qty), tone)}<small>${pct(l.done, l.planned_qty)}%</small></td>
        <td data-label="Status"><span class="st ${tone}">${st}</span></td>
        <td class="actcell">${editable && released ? '<button type="button" class="btn small primary plus">＋ Done</button>' : ""}</td>
      </tr>
      <tr class="logrow" data-for="${l.id}" hidden><td class="ln"></td><td colspan="9">
        ${editable && released ? `<form class="donef">
          <b>Finished now:</b>
          <input name="qty" inputmode="decimal" class="qty" placeholder="${qtyFmt(bal) || "qty"}" required>
          <span class="muted small">${h(l.uom || "pcs")}</span>
          <label class="small">on <input type="date" name="date" value="${d.today}"></label>
          <button class="btn small primary">Save</button>
          <span class="muted small">Adds to stock and uses up its material per piece.</span>
        </form>` : ""}
        ${l.logs.length ? `<table class="grid mini logs"><tr><th>Date</th><th>Shift</th><th class="num">Qty</th><th>Operator / remarks</th><th>By</th>${editable ? "<th></th>" : ""}</tr>
          ${l.logs.map((g) => `<tr><td>${dmy(g.log_date)}</td><td>${h(g.shift || "")}</td><td class="num">${qtyFmt(g.qty)}</td><td>${h([g.operator, g.remarks].filter(Boolean).join(" · "))}</td><td>${h(g.by_user || "")}</td>
            ${editable ? `<td><button type="button" class="btn small undo" data-log="${g.id}">Undo</button></td>` : ""}</tr>`).join("")}</table>`
          : '<p class="muted small">Nothing logged yet.</p>'}
      </td></tr>`;
    }).join("");

    layout(`
      <div class="head"><h1>Production Plan</h1>
        <div class="actions">
          ${editable ? '<a class="btn primary" href="#/production/daily">📝 Daily entry</a>' : ""}
          <a class="btn" href="#/production/log">📋 Production log</a>
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
      ${!plan ? `<div class="card empty">
          <p><b>No plan for this ${word} yet.</b></p>
          ${editable ? `<p class="muted">Add the products to make, how many, and by when. The floor then logs what is finished each day.</p>
            <button class="btn primary" id="make">＋ Make this ${word}'s plan</button>` : '<p class="muted">The planner has not made one yet.</p>'}
        </div>` : `
      <div class="overall card">
        <div class="ohead"><span>${isNow ? `This ${word}` : h(periodLabel(period, d.start, d.end))}: <b>${overall}% done</b></span>
          <span class="pill ${released ? "ok" : "warn"}">${released ? "Released" : "Draft"}</span></div>
        ${bar(overall, overall >= 100 ? "done" : late ? "late" : done ? "prog" : "none")}
        <p class="muted small">${qtyFmt(done)} of ${qtyFmt(planned)} planned finished · ${lines.filter((l) => l.done >= l.planned_qty).length} of ${lines.length} rows complete${late ? ` · <b class="neg">${late} late</b>` : ""}</p>
        ${!released ? `<p class="small">${editable ? "Draft: check the rows, then press <b>Release plan</b> so the floor can log what's finished." : "Draft: the planner is still working on this plan."}</p>` : ""}
        ${plan.notes ? `<p class="small">📝 ${h(plan.notes)}</p>` : ""}
      </div>
      <div class="scroll"><table class="grid plan">
        <tr><th>#</th><th>Product</th><th>Target</th><th>Sales order</th><th class="num">Planned</th><th class="num">Done</th><th class="num">Balance</th><th>Progress</th><th>Status</th><th></th></tr>
        ${rows || `<tr><td colspan="10" class="muted">No rows yet. ${editable ? `<a href="#/production/${plan.id}/edit">Add products</a>` : ""}</td></tr>`}
      </table></div>`}
      ${d.others.length ? `<h3>All plans</h3><div class="scroll"><table class="grid mini">
        <tr><th>Plan</th><th>Status</th><th class="num">Rows</th><th class="num">Planned</th><th class="num">Done</th><th>Progress</th><th class="num">Late</th>${editable ? "<th></th>" : ""}</tr>
        ${d.others.map((o) => { const op = pct(Number(o.done), Number(o.planned)); return `<tr class="click" data-href="${boardHref(o.period, o.start_date)}">
          <td class="nowrap">${h(periodLabel(o.period, o.start_date, o.end_date))}</td><td>${h(o.status)}</td>
          <td class="num">${o.lines}</td><td class="num">${qtyFmt(o.planned)}</td><td class="num">${qtyFmt(o.done)}</td>
          <td class="pcell">${bar(op, op >= 100 ? "done" : Number(o.late) ? "late" : op ? "prog" : "none")}<small>${op}%</small></td>
          <td class="num ${Number(o.late) ? "neg" : ""}">${o.late}</td>
          ${editable ? `<td class="nowrap"><a class="btn small" href="#/production/${o.id}/edit">✏️ Edit</a>
            ${isAdmin() || !Number(o.done) ? `<button type="button" class="btn small delplan" data-id="${o.id}" data-done="${Number(o.done) ? 1 : 0}">🗑 Delete</button>` : ""}</td>` : ""}</tr>`; }).join("")}</table></div>` : ""}`);
    $$("button.delplan").forEach((b) => (b.onclick = async () => {
      if (!armed(b, b.dataset.done === "1" ? "Delete plan and its entries? Click again" : "Sure? Click again")) return;
      b.disabled = true;
      try {
        const r = await api("DELETE", `/api/production/${b.dataset.id}`);
        flash(r.entries ? `Plan deleted, with its ${r.entries} production ${r.entries === 1 ? "entry" : "entries"} and their stock entries.` : "Plan deleted.");
      } catch (err) { flash(err.message, "error"); }
      route();
    }));

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
    $("#release")?.addEventListener("click", setStatus("Released", "Plan released. The floor can now log finished quantity with ＋ Done."));
    $("#draft")?.addEventListener("click", setStatus("Draft", "Plan is back in draft."));
    const toggle = (id, focus) => {
      const r = $(`tr.logrow[data-for="${id}"]`);
      r.hidden = focus ? false : !r.hidden;
      if (!r.hidden && focus) $("input[name=qty]", r)?.focus();
    };
    $$("button.plus").forEach((b) => (b.onclick = () => toggle(b.closest("tr").dataset.line, true)));
    $$("a.donecount").forEach((a) => (a.onclick = (e) => { e.preventDefault(); toggle(a.closest("tr").dataset.line); }));
    $$("form.donef").forEach((f) => (f.onsubmit = async (e) => {
      e.preventDefault();
      const id = f.closest("tr").dataset.for, btn = $("button", f);
      busy(btn, true, "Saving…");
      try {
        await api("POST", `/api/production/line/${id}/done`, { qty: f.qty.value, date: f.date.value });
        flash("Finished quantity saved and added to stock.");
      } catch (err) { flash(err.message, "error"); }
      route();
    }));
    $$("button.undo").forEach((b) => (b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Sure? Click again"; b.classList.add("danger"); return; }
      b.disabled = true;
      try { await api("DELETE", `/api/production/log/${b.dataset.log}`); flash("Entry undone. Its stock entry was removed too."); }
      catch (err) { flash(err.message, "error"); }
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

  // ============================================================== DAILY PRODUCTION ENTRY
  // Any number of partial entries per day; each one is saved and traced on its own.
  const SHIFTS = ["", "A", "B", "C", "General"];
  const planName = (l) => `${l.period === "month" ? "Month" : "Week"} plan ${dmy(l.start_date)}`;

  async function daily() {
    if (!can("production", "edit")) return ctx.forbidden();
    const p = params();
    const day = p.get("date") || today();
    const [{ products }, { rows: open }, { rows: done }] = await Promise.all([
      api("GET", "/api/production/options"),
      api("GET", "/api/production/open-lines?" + new URLSearchParams({ date: day })),
      api("GET", "/api/production/log?" + new URLSearchParams({ from: day, to: day })),
    ]);
    const planned = new Set(open.map((l) => String(l.product_id)));
    const prodOpts = (sel) => '<option value="">— pick product —</option>' + products
      .map((x) => `<option value="${x.id}" ${String(sel) === String(x.id) ? "selected" : ""}>${planned.has(String(x.id)) ? "★ " : ""}${h(x.code)} · ${h(x.name)}</option>`).join("");
    const planOpts = (productId) => {
      const rows = open.filter((l) => String(l.product_id) === String(productId));
      const pick = rows.find((l) => l.done < l.planned_qty) || rows[0];
      return rows.map((l) => `<option value="${l.id}" ${l === pick ? "selected" : ""}>${h(planName(l))} · balance ${qtyFmt(Math.max(0, l.planned_qty - l.done))}${l.order_no ? ` · ${h(l.order_no)}` : ""}</option>`).join("")
        + `<option value="" ${pick ? "" : "selected"}>— not in a plan —</option>`;
    };
    const row = () => `<tr><td><select name="product_id" class="prod wide">${prodOpts()}</select></td>
      <td><input name="qty" inputmode="decimal" class="qty"></td>
      <td><select name="line_id" class="toward"><option value="">— pick product first —</option></select></td>
      <td><input name="remarks" placeholder="optional"></td>
      <td><button type="button" class="rm" title="Remove">✕</button></td></tr>`;
    const total = done.reduce((t, r) => t + r.qty, 0);
    layout(`
      <div class="head"><h1>Daily production entry</h1>
        <div class="actions"><a class="btn" href="#/production">🗓️ Plan board</a><a class="btn" href="#/production/log">📋 Production log</a></div></div>
      <div id="err"></div>
      <form id="f" class="card">
        <p class="muted small">Enter what was made. Part quantities are fine: make another entry later in the day or shift and they add up. Each entry adds the product to stock and uses up its material per piece.</p>
        <div class="form-grid">
          <label>Date <input type="date" name="date" value="${h(day)}" required></label>
          <label>Shift <select name="shift">${SHIFTS.map((s) => `<option value="${s}" ${p.get("shift") === s ? "selected" : ""}>${s || "—"}</option>`).join("")}</select></label>
          <label>Operator / supervisor <input name="operator" value="${h(p.get("operator") || "")}" placeholder="optional"></label>
        </div>
        <div class="scroll"><table class="lines dailylines"><thead><tr><th>Product</th><th>Qty made</th><th>Counts toward</th><th>Remarks</th><th></th></tr></thead>
          <tbody id="rows">${row()}${row()}${row()}</tbody></table></div>
        <button type="button" class="btn small" id="add">＋ Add row</button>
        ${open.length ? '<p class="muted small">★ = in a released plan for this date. The entry counts toward that plan row\'s Done.</p>' : '<p class="muted small">No released plan covers this date, so entries are saved without a plan.</p>'}
        <div class="buttons"><button class="btn primary">💾 Save entries</button></div>
      </form>
      <h3>Entries on ${dmy(day)} <small class="muted">(${done.length} · ${qtyFmt(total)} made)</small></h3>
      ${logTable(done, { compact: true })}`);
    const doneRows = done;
    $("#add").onclick = () => $("#rows").insertAdjacentHTML("beforeend", row());
    $("#f").addEventListener("click", (e) => { if (e.target.classList.contains("rm")) e.target.closest("tr").remove(); });
    $("#f").addEventListener("change", (e) => {
      if (e.target.name === "product_id") $("[name=line_id]", e.target.closest("tr")).innerHTML = e.target.value ? planOpts(e.target.value) : '<option value="">— pick product first —</option>';
      if (e.target.name === "date" && e.target.closest("#f")) location.hash = "#/production/daily?" + new URLSearchParams({ date: e.target.value, shift: $("#f").shift.value, operator: $("#f").operator.value });
    });
    wireUndo(doneRows);
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, btn = $("button.primary", f);
      const lines = $$("#rows tr").map((tr) => Object.fromEntries(["product_id", "qty", "line_id", "remarks"].map((k) => [k, $(`[name=${k}]`, tr).value])))
        .filter((l) => l.product_id || l.qty);
      if (lines.some((l) => !l.product_id || !l.qty)) { $("#err").innerHTML = errorBox(["Each row needs both a product and the quantity made."]); return scrollTo(0, 0); }
      busy(btn, true, "Saving…");
      try {
        const r = await api("POST", "/api/production/daily", { date: f.date.value, shift: f.shift.value, operator: f.operator.value, lines });
        flash(`${r.saved} ${r.saved === 1 ? "entry" : "entries"} saved and added to stock.`);
        const next = "#/production/daily?" + new URLSearchParams({ date: f.date.value, shift: f.shift.value, operator: f.operator.value });
        if (location.hash === next) route(); else location.hash = next;
      } catch (err) { $("#err").innerHTML = errorBox([err.message]); busy(btn, false); scrollTo(0, 0); }
    };
  }

  // ============================================================== PRODUCTION LOG (trace)
  function logTable(rows, { compact = false } = {}) {
    const editable = can("production", "edit");
    if (!rows.length) return '<p class="muted small">No entries.</p>';
    return `<div class="scroll"><table class="grid tracelog">
      <tr><th>Date</th><th>Shift</th><th>Product</th><th class="num">Qty</th><th>Operator</th>${compact ? "" : "<th>Plan</th><th>Sales order</th>"}<th>Remarks</th>${compact ? "" : "<th>Material used</th>"}<th>Entered</th>${editable ? "<th></th>" : ""}</tr>
      ${rows.map((r) => `<tr>
        <td>${dmy(r.log_date)}</td><td>${h(r.shift || "")}</td>
        <td><a href="#/production/log?product=${r.product_id}" title="Trace this product"><b>${h(r.code)}</b></a> · ${h(r.name)}</td>
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

  async function log() {
    const p = params();
    const monthStart = today().slice(0, 8) + "01";
    const f = { from: p.get("from") || monthStart, to: p.get("to") || today(), product: p.get("product") || "", shift: p.get("shift") || "", q: p.get("q") || "" };
    const { rows, products } = await api("GET", "/api/production/log?" + new URLSearchParams(f));
    const byProduct = new Map();
    for (const r of rows) { const x = byProduct.get(r.product_id) || { code: r.code, name: r.name, uom: r.uom, qty: 0, n: 0, days: new Set() }; x.qty += r.qty; x.n++; x.days.add(r.log_date); byProduct.set(r.product_id, x); }
    const prodName = products.find((x) => String(x.id) === f.product);
    layout(`
      <div class="head"><h1>Production log ${prodName ? `<small>${h(prodName.code)} · ${h(prodName.name)}</small>` : ""}</h1>
        <div class="actions">
          ${can("production", "edit") ? '<a class="btn primary" href="#/production/daily">📝 Daily entry</a>' : ""}
          <a class="btn" href="#/production">🗓️ Plan board</a>
          <button class="btn" id="exx">⬇ Excel</button></div></div>
      <form class="filters" id="flt">
        <label>From <input type="date" name="from" value="${h(f.from)}"></label>
        <label>To <input type="date" name="to" value="${h(f.to)}"></label>
        <select name="product"><option value="">All products</option>${products.map((x) => `<option value="${x.id}" ${f.product === String(x.id) ? "selected" : ""}>${h(x.code)} · ${h(x.name)}</option>`).join("")}</select>
        <select name="shift"><option value="">All shifts</option>${SHIFTS.filter(Boolean).map((s) => `<option ${f.shift === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <input name="q" value="${h(f.q)}" placeholder="Operator, remarks, item…">
        <button class="btn">Show</button>
      </form>
      <div class="kpis">
        <div class="kpi"><span>Entries</span><b>${rows.length}</b><small>${dmy(f.from)} to ${dmy(f.to)}</small></div>
        <div class="kpi"><span>Total made</span><b>${qtyFmt(rows.reduce((t, r) => t + r.qty, 0))}</b><small>${byProduct.size} product${byProduct.size === 1 ? "" : "s"}</small></div>
        <div class="kpi"><span>Days with production</span><b>${new Set(rows.map((r) => r.log_date)).size}</b></div>
      </div>
      ${byProduct.size > 1 ? `<h3>Total by product</h3><div class="scroll"><table class="grid mini"><tr><th>Product</th><th class="num">Made</th><th class="num">Entries</th><th class="num">Days</th></tr>
        ${[...byProduct].sort((a, b) => b[1].qty - a[1].qty).map(([id, x]) => `<tr class="click" data-href="#/production/log?${new URLSearchParams({ ...f, product: id })}"><td><b>${h(x.code)}</b> · ${h(x.name)}</td>
          <td class="num">${qtyFmt(x.qty)} <span class="muted small">${h(x.uom || "")}</span></td><td class="num">${x.n}</td><td class="num">${x.days.size}</td></tr>`).join("")}</table></div>` : ""}
      <h3>All entries</h3>
      ${logTable(rows)}`);
    const go = () => { location.hash = "#/production/log?" + new URLSearchParams(new FormData($("#flt"))); };
    $("#flt").onsubmit = (e) => { e.preventDefault(); go(); };
    $$("#flt select").forEach((s) => (s.onchange = go));
    wireUndo(rows);
    $("#exx").onclick = () => saveSheets(`production_log_${f.from}_to_${f.to}.xlsx`, [["Production log", [
      ["Date", "Shift", "Item Code", "Product", "Qty", "UOM", "Operator", "Plan", "Sales Order", "Customer", "Remarks", "Material used", "Entered by", "Entered at"],
      ...rows.map((r) => [dmy(r.log_date), r.shift || "", r.code, r.name, r.qty, r.uom || "", r.operator || "", r.plan_start ? `${r.period} ${dmy(r.plan_start)}` : "",
        r.order_no || "", r.order_party || "", r.remarks || "", r.consumed || "", r.by_user || "", r.entered_at || ""])]]], "xlsx");
  }

  return { board, edit, daily, log };
}
