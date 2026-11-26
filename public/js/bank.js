// Bank statement: upload the bank's Excel/CSV, match money in/out to invoices and vendor bills,
// and post the rest (charges, salaries, taxes...) as expenses.

import { saveSheets } from "./download.js";

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isNaN(n) ? 0 : n; };

// ---------------------------------------------------------------- reading the statement file
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function toIso(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && v > 20000 && v < 80000) {           // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^(\d{1,2})[\/\-. ]?([A-Za-z]{3})[A-Za-z]*[\/\-. ,]*(\d{2,4})/);
  if (m && MON[m[2].toUpperCase()]) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${String(MON[m[2].toUpperCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return null;
}
const amt = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[,₹\s]/g, "").replace(/(Cr|Dr|CR|DR)\.?$/, "");
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
};

/** Finds the header row and the columns, whatever the bank calls them. */
export function readStatement(XLSX, wb) {
  const out = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    let head = -1, col = {};
    for (let i = 0; i < Math.min(rows.length, 60) && head < 0; i++) {
      const cells = (rows[i] || []).map((c) => String(c ?? "").trim().toLowerCase());
      const find = (re, not) => cells.findIndex((c) => re.test(c) && !(not && not.test(c)));
      const date = find(/(txn|tran|transaction|value)?\s*date/, /value date/) >= 0 ? find(/(txn|tran|transaction|value)?\s*date/, /value date/) : find(/date/);
      const desc = find(/description|narration|particular|remark|details/);
      const debit = find(/withdraw|debit|\bdr\b|paid out/);
      const credit = find(/deposit|credit|\bcr\b|paid in/);
      const amount = find(/^amount|amount\s*\(|txn amount|transaction amount/);
      const type = find(/dr\s*\/\s*cr|cr\s*\/\s*dr|type/);
      if (date >= 0 && desc >= 0 && ((debit >= 0 && credit >= 0) || (amount >= 0 && type >= 0))) {
        head = i;
        col = { date, desc, debit, credit, amount, type, ref: find(/ref|chq|cheque|utr/), balance: find(/balance/) };
      }
    }
    if (head < 0) continue;
    for (const r of rows.slice(head + 1)) {
      if (!r) continue;
      const date = toIso(r[col.date]);
      if (!date) continue;
      let debit = 0, credit = 0;
      if (col.debit >= 0 && col.credit >= 0) { debit = Math.abs(amt(r[col.debit])); credit = Math.abs(amt(r[col.credit])); }
      else { const a = Math.abs(amt(r[col.amount])); if (/^c/i.test(String(r[col.type] || "").trim())) credit = a; else debit = a; }
      if (!debit && !credit) continue;
      out.push({ date, description: String(r[col.desc] ?? "").replace(/\s+/g, " ").trim(), ref: col.ref >= 0 ? String(r[col.ref] ?? "").trim() : "",
        debit: r2(debit), credit: r2(credit), balance: col.balance >= 0 ? amt(r[col.balance]) || null : null });
    }
  }
  return out;
}

// ---------------------------------------------------------------- bill matching (same rules as the server)
function matchAmount(open, amount) {
  const near = (x) => Math.abs(x - amount) <= 1;
  const one = open.find((b) => near(b.balance));
  if (one) return { exact: true, pick: [{ id: one.id, ref: one.ref, amount: one.balance }] };
  let run = 0;
  for (let i = 0; i < open.length; i++) {
    run = r2(run + open[i].balance);
    if (near(run)) return { exact: true, pick: open.slice(0, i + 1).map((b) => ({ id: b.id, ref: b.ref, amount: b.balance })) };
    if (run > amount + 1) break;
  }
  let left = amount; const pick = [];
  for (const b of open) { if (left <= 0.005) break; const use = r2(Math.min(left, b.balance)); pick.push({ id: b.id, ref: b.ref, amount: use }); left = r2(left - use); }
  return { exact: false, pick };
}

// ---------------------------------------------------------------- pages
export function bankPages({ api, layout, can, flash, $, $$, errorBox, busy }) {
  const route = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
  const params = () => new URLSearchParams(location.hash.split("?")[1] || "");
  const today = () => new Date().toISOString().slice(0, 10);
  const tabs = (on) => `<div class="tabs">
    <a class="${on === "new" ? "on" : ""}" href="#/bank">To match</a><a class="${on === "done" ? "on" : ""}" href="#/bank?status=done">Done</a>
    <a class="${on === "acc" ? "on" : ""}" href="#/bank/accounts">Bank accounts</a>
    <a class="${on === "exp" ? "on" : ""}" href="#/bank/expenses">Expenses &amp; other income</a></div>`;
  const accOpts = (list, sel, first) => (first ? `<option value="">${first}</option>` : "") +
    list.map((a) => `<option value="${a.id}" ${Number(sel) === a.id ? "selected" : ""}>${h(a.name)}${a.account_no ? ` · ${h(String(a.account_no).slice(-4))}` : ""}${a.active ? "" : " (inactive)"}</option>`).join("");

  async function bank() {
    const sp = params();
    const status = sp.get("status") === "done" ? "done" : "new";
    const account = sp.get("account") || "";
    const qs = new URLSearchParams({ status });
    for (const k of ["account", "from", "to", "q"]) if (sp.get(k)) qs.set(k, sp.get(k));
    const d = await api("GET", `/api/bank?${qs}`);
    const editable = can("accounts", "edit");
    const active = d.accounts.filter((a) => a.active);
    const many = d.accounts.length > 1;
    const party = (dir, id) => (dir === "in" ? d.customers : d.vendors).find((c) => c.id === id);
    const opts = (list, sel) => '<option value="">— pick —</option>' + list.map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${h(c.name)}</option>`).join("");
    const catOpts = (credit, sel) => '<option value="">— pick —</option>' + d.categories
      .filter((c) => (credit ? /income|Interest received|Owner|Transfer/.test(c) : !/income|Interest received/.test(c)))
      .map((c) => `<option ${c === sel ? "selected" : ""}>${h(c)}</option>`).join("");
    const pickAcc = account || (active.length === 1 ? active[0].id : "");

    layout(`
      <div class="head"><h1>🏦 Bank statement</h1><div class="actions"><a class="btn" href="#/accounts">← Accounts</a></div></div>
      ${tabs(status)}
      ${editable && status === "new" ? `<div class="card">
        ${d.accounts.length ? "" : `<p><b>First, add your bank account</b> on the <a href="#/bank/accounts">Bank accounts</a> tab (name, account number, opening balance). If you upload now, a "Main bank account" is made for you and you can rename it later.</p>`}
        <div class="form-grid">
          ${d.accounts.length ? `<label>Bank account <select id="upacc">${accOpts(active, pickAcc, active.length > 1 ? "— pick the account —" : "")}</select>
            <small class="muted"><a href="#/bank/accounts?add=1">＋ Add another account</a></small></label>` : ""}
          <label class="${d.accounts.length ? "" : "full"}"><b>Upload the bank statement</b> (Excel or CSV downloaded from net banking)
            <input type="file" id="file" accept=".xls,.xlsx,.csv"></label></div>
        <p class="muted small">Entries already uploaded are skipped, so you can upload an overlapping period safely.
          For each entry the app suggests the customer or vendor and the invoices it settles, a transfer between your own accounts, or what kind of expense it is. Check and press <b>Post</b>.</p>
        <div id="up"></div></div>` : ""}
      <form class="filters" id="flt"><input type="hidden" name="status" value="${status}">
        ${many ? `<select name="account">${accOpts(d.accounts, account, "All accounts")}</select>` : ""}
        ${status === "done" ? `<label>From <input type="date" name="from" value="${h(sp.get("from") || "")}"></label><label>To <input type="date" name="to" value="${h(sp.get("to") || "")}"></label>
          <input name="q" placeholder="Search description, party, category" value="${h(sp.get("q") || "")}"><button class="btn">Show</button>
          <button type="button" class="btn" id="exx">⬇ Excel</button>` : ""}</form>
      <div id="err"></div>
      ${status === "new" ? `
        ${d.lines.length ? `<div class="scroll"><table class="grid bank">
          <tr><th><input type="checkbox" id="all" checked></th><th>Date</th><th>Description</th><th class="num">In</th><th class="num">Out</th><th>Post as</th><th>Details</th></tr>
          ${d.lines.map((l) => row(l)).join("")}</table></div>
          ${editable ? `<div class="buttons"><button class="btn primary" id="post">✓ Post ticked entries</button>
            <button class="btn" id="del" title="For entries uploaded by mistake or to the wrong account">🗑 Delete ticked</button></div>` : ""}`
        : '<p class="muted">Nothing waiting. Upload a statement to start.</p>'}`
      : `<p class="muted small">${d.lines.length} entries${d.lines.length >= 1000 ? " (the latest 1000; narrow the dates to see older ones)" : ""} ·
          In ₹ ${money(d.lines.reduce((t, l) => t + Number(l.credit), 0))} · Out ₹ ${money(d.lines.reduce((t, l) => t + Number(l.debit), 0))}</p>
        <div class="scroll"><table class="grid"><tr><th>Date</th>${many ? "<th>Account</th>" : ""}<th>Description</th><th class="num">In</th><th class="num">Out</th><th>Posted as</th>${editable ? "<th></th>" : ""}</tr>
          ${d.lines.map((l) => `<tr><td>${dmy(l.txn_date)}</td>${many ? `<td>${h(l.account)}</td>` : ""}<td class="wrap">${h(l.description)}${l.ref ? `<br><small class="muted">${h(l.ref)}</small>` : ""}</td>
            <td class="num">${Number(l.credit) ? money(l.credit) : ""}</td><td class="num">${Number(l.debit) ? money(l.debit) : ""}</td><td>${h(l.posted_as)}</td>
            ${editable ? `<td><button class="btn small" data-undo="${l.id}">Undo</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="7" class="muted">Nothing posted${sp.get("q") || sp.get("from") ? " for this filter" : " yet"}.</td></tr>`}</table></div>`}`);

    function row(l) {
      const s = l.suggest || {};
      const credit = Number(l.credit) > 0;
      const dir = credit ? "in" : "out";
      const kinds = [["", "— choose —"], [dir, credit ? "Received from customer" : "Paid to vendor"], ["expense", credit ? "Other income" : "Expense / charges"]];
      if (many) kinds.push(["transfer", credit ? "Transfer from own account" : "Transfer to own account"]);
      kinds.push(["ignore", "Ignore"]);
      if (s.kind === "link") kinds.splice(1, 0, ["link", "Already entered"]);
      return `<tr data-id="${l.id}" data-dir="${dir}" data-amt="${credit ? l.credit : l.debit}" data-acc="${l.account_id || ""}">
        <td><input type="checkbox" name="tick" ${s.kind ? "checked" : ""}></td><td>${dmy(l.txn_date)}</td>
        <td class="wrap">${h(l.description)}${l.ref ? `<br><small class="muted">${h(l.ref)}</small>` : ""}${many && !account ? `<br><small class="muted">🏦 ${h(l.account || "")}</small>` : ""}</td>
        <td class="num">${credit ? `<b>${money(l.credit)}</b>` : ""}</td><td class="num">${credit ? "" : `<b>${money(l.debit)}</b>`}</td>
        <td><select name="kind">${kinds.map(([k, t]) => `<option value="${k}" ${k === (s.kind || "") ? "selected" : ""}>${t}</option>`).join("")}</select>
          ${s.why ? `<br><small class="muted">${h(s.why)}</small>` : ""}</td>
        <td class="det" data-payment="${s.payment_id || ""}" data-party="${s.party_id || ""}" data-cat="${h(s.category || "")}" data-to="${s.account_id || ""}"
          data-alloc='${h(JSON.stringify(s.allocations || []))}'></td></tr>`;
    }

    // details cell follows the "Post as" choice
    const fill = (tr) => {
      const kind = $("[name=kind]", tr).value, dir = tr.dataset.dir, det = $(".det", tr), amount = Number(tr.dataset.amt);
      if (kind === "in" || kind === "out") {
        const pid = Number(det.dataset.party) || null;
        const open = d.bills[dir].filter((b) => b.party_id === pid);
        let alloc = JSON.parse(det.dataset.alloc || "[]");
        if (!alloc.length && pid) alloc = matchAmount(open, amount).pick;
        det.dataset.alloc = JSON.stringify(alloc);
        const tied = r2(alloc.reduce((t, a) => t + a.amount, 0));
        det.innerHTML = `<select name="party">${opts(dir === "in" ? d.customers : d.vendors, pid)}</select>
          ${pid ? `<div class="bills">${open.length ? open.map((b) => {
            const a = alloc.find((x) => x.id === b.id);
            return `<label class="check inline"><input type="checkbox" data-bill="${b.id}" ${a ? "checked" : ""}> ${h(b.ref)} <small class="muted">bal ${money(b.balance)}</small>
              ${a ? `<input class="qty" data-billamt="${b.id}" value="${a.amount}">` : ""}</label>`;
          }).join("") : '<small class="muted">No open bills.</small>'}</div>
          <small class="${Math.abs(tied - amount) < 0.01 ? "ok-ink" : "pend"}">${Math.abs(tied - amount) < 0.01 ? "✓ Settles bills exactly" : `Against bills ₹ ${money(tied)} · advance ₹ ${money(amount - tied)}`}</small>` : ""}`;
        $("[name=party]", det).onchange = (e) => { det.dataset.party = e.target.value; det.dataset.alloc = "[]"; fill(tr); };
        $$("[data-bill]", det).forEach((cb) => (cb.onchange = () => {
          let a = JSON.parse(det.dataset.alloc || "[]");
          const b = open.find((x) => x.id === Number(cb.dataset.bill));
          if (cb.checked) { const left = r2(amount - a.reduce((t, x) => t + x.amount, 0)); a.push({ id: b.id, ref: b.ref, amount: r2(Math.max(0, Math.min(b.balance, left))) }); }
          else a = a.filter((x) => x.id !== b.id);
          det.dataset.alloc = JSON.stringify(a.filter((x) => x.amount > 0)); fill(tr);
        }));
        $$("[data-billamt]", det).forEach((inp) => (inp.onchange = () => {
          const a = JSON.parse(det.dataset.alloc || "[]").map((x) => (x.id === Number(inp.dataset.billamt) ? { ...x, amount: r2(num(inp.value)) } : x));
          det.dataset.alloc = JSON.stringify(a.filter((x) => x.amount > 0)); fill(tr);
        }));
      } else if (kind === "expense") {
        det.innerHTML = `<select name="cat">${catOpts(dir === "in", det.dataset.cat)}</select>`;
        $("[name=cat]", det).onchange = (e) => (det.dataset.cat = e.target.value);
      } else if (kind === "transfer") {
        const others = d.accounts.filter((a) => a.id !== Number(tr.dataset.acc));
        det.innerHTML = `<select name="toacc">${accOpts(others, det.dataset.to, dir === "in" ? "— from which account —" : "— to which account —")}</select>
          <br><small class="muted">Not an expense. The same entry on the other account's statement is closed too.</small>`;
        $("[name=toacc]", det).onchange = (e) => (det.dataset.to = e.target.value);
      } else if (kind === "link") {
        const pr = party(dir, Number(det.dataset.party));
        det.innerHTML = `<small>Payment already entered${pr ? ` for <b>${h(pr.name)}</b>` : ""}. It will be marked as seen in the bank, no new entry.</small>`;
      } else det.innerHTML = "";
    };
    $$("table.bank tr[data-id]").forEach((tr) => {
      fill(tr);
      $("[name=kind]", tr).onchange = () => { $("[name=tick]", tr).checked = !!$("[name=kind]", tr).value; fill(tr); };
    });
    const all = $("#all");
    if (all) all.onchange = () => $$("table.bank [name=tick]").forEach((t) => (t.checked = all.checked));
    $("#flt").onsubmit = (e) => {
      e.preventDefault();
      const f = new URLSearchParams([...new FormData(e.target)].filter(([k, v]) => v && !(k === "status" && v === "new")));
      location.hash = "#/bank" + (String(f) ? "?" + f : "");
    };
    const accSel = $("#flt [name=account]");
    if (accSel && status === "new") accSel.onchange = () => $("#flt").requestSubmit();

    const file = $("#file");
    if (file) file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      const accId = $("#upacc") ? $("#upacc").value : "";
      if ($("#upacc") && !accId) { $("#up").innerHTML = errorBox(["Pick the bank account this statement is for, then choose the file again."]); file.value = ""; return; }
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: false });
        const rows = readStatement(XLSX, wb);
        if (!rows.length) { $("#up").innerHTML = errorBox(["No entries found. The file needs columns for date, description, and withdrawal / deposit (or amount with Dr/Cr). Please download the statement as Excel or CSV."]); return; }
        const res = await api("POST", "/api/bank/upload", { rows, file: f.name, account_id: accId || null });
        flash(`${res.added} new entries loaded${res.skipped ? `, ${res.skipped} already there or empty skipped` : ""}.`);
        route();
      } catch (err) { $("#up").innerHTML = errorBox([err.message]); }
    };
    const ticked = () => $$("table.bank tr[data-id]").filter((tr) => $("[name=tick]", tr).checked);
    const post = $("#post");
    if (post) post.onclick = async () => {
      const items = ticked().filter((tr) => $("[name=kind]", tr).value).map((tr) => {
        const det = $(".det", tr), kind = $("[name=kind]", tr).value;
        return { id: Number(tr.dataset.id), kind, party_id: Number(det.dataset.party) || null, payment_id: Number(det.dataset.payment) || null,
          category: det.dataset.cat || "", account_id: Number(det.dataset.to) || null, allocations: JSON.parse(det.dataset.alloc || "[]") };
      });
      if (!items.length) { $("#err").innerHTML = errorBox(["Tick at least one entry and choose what it is."]); return; }
      busy(post, true, "Posting…");
      try {
        const res = await api("POST", "/api/bank/post", { items });
        flash(`${res.done} entries posted.`);
        if (res.errors.length) flash(res.errors.join(" · "), "error");
        route();
      } catch (err) { $("#err").innerHTML = errorBox([err.message]); busy(post, false); }
    };
    const del = $("#del");
    if (del) del.onclick = async () => {
      const ids = ticked().map((tr) => Number(tr.dataset.id));
      if (!ids.length) { $("#err").innerHTML = errorBox(["Tick the entries to delete."]); return; }
      if (!confirm(`Delete ${ids.length} ticked entries from To match? Upload the statement again to bring them back.`)) return;
      const res = await api("POST", "/api/bank/lines/delete", { ids });
      flash(`${res.deleted} entries deleted.`); route();
    };
    $$("[data-undo]").forEach((b) => (b.onclick = async () => { await api("POST", `/api/bank/undo/${b.dataset.undo}`, {}); flash("Entry is back in To match."); route(); }));
    const exx = $("#exx");
    if (exx) exx.onclick = () => saveSheets(`bank_posted_${today()}.xlsx`, [["Posted", [["Date", "Account", "Description", "Reference", "In", "Out", "Posted as"],
      ...d.lines.map((l) => [dmy(l.txn_date), l.account || "", l.description, l.ref || "", Number(l.credit) || "", Number(l.debit) || "", l.posted_as || ""])]]]);
  }

  // ---------------------------------------------------------------- bank accounts: balances, add / edit
  async function accounts() {
    const sp = params();
    const d = await api("GET", "/api/bank/accounts");
    const editable = can("accounts", "edit");
    const editId = sp.get("edit");
    const editing = editId ? d.accounts.find((a) => String(a.id) === editId) : null;
    const showForm = editable && (sp.get("add") || editing || !d.accounts.length);
    const act = d.accounts.filter((a) => a.active);
    const total = r2(act.reduce((t, a) => t + a.balance, 0));
    const ub = { in: d.unbanked.filter((p) => p.direction === "in"), out: d.unbanked.filter((p) => p.direction === "out") };
    const sum = (l) => r2(l.reduce((t, p) => t + Number(p.amount), 0));
    const a = editing || {};
    const check = (x) => x.bank_balance === null ? '<span class="muted small">No balance column</span>'
      : Math.abs(x.difference) <= 0.5 ? '<span class="ok-ink">✓ Matches bank</span>'
      : `<b class="neg">Differs ₹ ${money(x.difference)}</b><br><small class="muted">Entries missing or opening balance wrong</small>`;

    layout(`
      <div class="head"><h1>🏦 Bank accounts</h1><div class="actions">
        ${editable && !showForm ? '<a class="btn primary" href="#/bank/accounts?add=1">＋ Add bank account</a>' : ""}<a class="btn" href="#/accounts">← Accounts</a></div></div>
      ${tabs("acc")}
      ${act.length > 1 ? `<div class="quick slim"><div class="tile"><b class="big">₹ ${money(total)}</b><span>Total in all bank accounts</span></div></div>` : ""}
      ${showForm ? `<form class="card" id="af"><h3>${editing ? `Edit ${h(a.name)}` : "Add bank account"}</h3>
        <div class="form-grid">
          <label>Short name * <input name="name" value="${h(a.name || "")}" placeholder="e.g. HDFC current" required></label>
          <label>Bank <input name="bank_name" value="${h(a.bank_name || "")}" placeholder="e.g. HDFC Bank"></label>
          <label>Account number <input name="account_no" value="${h(a.account_no || "")}"></label>
          <label>IFSC <input name="ifsc" value="${h(a.ifsc || "")}"></label>
          <label>Branch <input name="branch" value="${h(a.branch || "")}"></label>
          <label>Opening balance (₹) <input name="opening_balance" inputmode="decimal" value="${editing && !a.opening_from_statement && a.opening_balance !== null ? h(a.opening_balance) : ""}" placeholder="Leave empty to read it from the statement">
            <small class="muted">Balance just before the first entry you upload. Leave empty if your statement has a Balance column.</small></label>
          <label>As on <input type="date" name="opening_date" value="${h(a.opening_date || "")}"></label>
          ${editing ? `<label class="check"><input type="checkbox" name="active" ${a.active ? "checked" : ""}> Active (shown for upload)</label>` : ""}
          <label class="full">Notes <input name="notes" value="${h(a.notes || "")}"></label>
        </div>
        <div id="aerr"></div>
        <div class="buttons"><button class="btn primary" id="asave">Save</button>${d.accounts.length ? '<a class="btn" href="#/bank/accounts">Cancel</a>' : ""}
          ${editing && !a.lines ? '<button type="button" class="btn" id="adel">🗑 Delete account</button>' : ""}</div></form>` : ""}
      ${d.accounts.length ? `<div class="scroll"><table class="grid">
        <tr><th>Account</th><th class="num">Opening</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th>Bank's own balance</th><th>Check</th><th class="num">To match</th></tr>
        ${d.accounts.map((x) => `<tr class="${x.active ? "" : "muted"}"><td><b>${h(x.name)}</b>${x.active ? "" : " (inactive)"}<br><small class="muted">${[x.bank_name, x.account_no, x.ifsc].filter(Boolean).map(h).join(" · ")}
            ${x.first_day ? `<br>Entries ${dmy(x.first_day)} to ${dmy(x.last_day)}` : "<br>No statement uploaded yet"}</small>
            <div class="buttons" style="margin-top:.4rem"><a class="btn small" href="#/bank/accounts/${x.id}">Statement</a>${editable ? ` <a class="btn small" href="#/bank/accounts?edit=${x.id}">Edit</a>` : ""}</div></td>
          <td class="num">${money(x.opening)}${x.opening_from_statement ? '<br><small class="muted">from statement</small>' : ""}</td>
          <td class="num">${money(x.money_in)}</td><td class="num">${money(x.money_out)}</td><td class="num"><b class="${x.balance < 0 ? "neg" : ""}">${money(x.balance)}</b></td>
          <td>${x.bank_balance === null ? "" : `₹ ${money(x.bank_balance)}<br><small class="muted">on ${dmy(x.bank_balance_day)}</small>`}</td><td>${check(x)}</td>
          <td class="num">${x.pending ? `<a href="#/bank?account=${x.id}">${x.pending}</a>` : "0"}</td></tr>`).join("")}
      </table></div>` : ""}
      <h3>Payments entered but not yet seen in the bank</h3>
      <p class="muted small">Receipts and payments typed in on Accounts (not cash) that no uploaded statement line is matched to yet: cheques not cleared, or a statement period not uploaded.
        When the statement comes, the app suggests "Already entered" for them.</p>
      ${d.unbanked.length ? `<div class="quick slim"><div class="tile"><b>₹ ${money(sum(ub.in))}</b><span>${ub.in.length} receipts not in bank yet</span></div>
        <div class="tile"><b>₹ ${money(sum(ub.out))}</b><span>${ub.out.length} payments not in bank yet</span></div></div>
        <div class="scroll"><table class="grid"><tr><th>Date</th><th>Party</th><th>Mode</th><th>Reference</th><th class="num">Received</th><th class="num">Paid</th></tr>
        ${d.unbanked.map((p) => `<tr><td>${dmy(p.pay_date)}</td><td>${h(p.party)}</td><td>${h(p.mode || "")}</td><td>${h(p.reference || "")}</td>
          <td class="num">${p.direction === "in" ? money(p.amount) : ""}</td><td class="num">${p.direction === "out" ? money(p.amount) : ""}</td></tr>`).join("")}</table></div>`
        : '<p class="muted">None. Every payment entered is matched to the bank.</p>'}`);

    const f = $("#af");
    if (f) {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(f));
        body.active = editing ? ($("[name=active]", f).checked ? 1 : 0) : 1;
        busy($("#asave"), true, "Saving…");
        try {
          if (editing) await api("PUT", `/api/bank/accounts/${editing.id}`, body); else await api("POST", "/api/bank/accounts", body);
          flash(`${body.name} saved.`); location.hash = "#/bank/accounts";
        } catch (err) { $("#aerr").innerHTML = errorBox([err.message]); busy($("#asave"), false); }
      };
      const del = $("#adel");
      if (del) del.onclick = async () => {
        if (!confirm(`Delete ${editing.name}?`)) return;
        try { await api("DELETE", `/api/bank/accounts/${editing.id}`); flash("Account deleted."); location.hash = "#/bank/accounts"; }
        catch (err) { $("#aerr").innerHTML = errorBox([err.message]); }
      };
    }
  }

  // ---------------------------------------------------------------- one account: statement with running balance
  async function accountStatement(id) {
    const sp = params();
    const qs = new URLSearchParams();
    for (const k of ["from", "to"]) if (sp.get(k)) qs.set(k, sp.get(k));
    const d = await api("GET", `/api/bank/accounts/${id}/statement?${qs}`);
    const a = d.account;
    const from = sp.get("from") || "", to = sp.get("to") || "";
    layout(`
      <div class="head"><h1>🏦 ${h(a.name)} <small>${[a.bank_name, a.account_no].filter(Boolean).map(h).join(" · ")}</small></h1>
        <div class="actions"><a class="btn" href="#/bank/accounts">← Bank accounts</a><button class="btn" id="exx">⬇ Excel</button></div></div>
      <form class="filters" id="flt"><label>From <input type="date" name="from" value="${h(from)}"></label><label>To <input type="date" name="to" value="${h(to)}"></label><button class="btn">Show</button></form>
      <div class="quick slim">
        <div class="tile"><b>₹ ${money(d.opening)}</b><span>Opening${from ? ` on ${dmy(from)}` : ""}</span></div>
        <div class="tile"><b>₹ ${money(d.money_in)}</b><span>Money in</span></div>
        <div class="tile"><b>₹ ${money(d.money_out)}</b><span>Money out</span></div>
        <div class="tile"><b>₹ ${money(d.closing)}</b><span>Closing</span></div></div>
      ${d.mismatches ? `<div class="flash error">${d.mismatches} entries do not agree with the bank's own balance. Look for the first ≠ below: an entry before it is missing (upload that period) or the opening balance is wrong (<a href="#/bank/accounts?edit=${a.id}">edit the account</a>).</div>` : ""}
      <div class="scroll"><table class="grid"><tr><th>Date</th><th>Description</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th class="num">Bank's balance</th><th></th><th>Posted as</th></tr>
        ${d.rows.map((r) => `<tr><td>${dmy(r.txn_date)}</td><td class="wrap">${h(r.description)}${r.ref ? `<br><small class="muted">${h(r.ref)}</small>` : ""}</td>
          <td class="num">${Number(r.credit) ? money(r.credit) : ""}</td><td class="num">${Number(r.debit) ? money(r.debit) : ""}</td><td class="num"><b>${money(r.running)}</b></td>
          <td class="num">${r.balance === null ? "" : money(r.balance)}</td><td>${r.check === null ? "" : r.check ? '<span class="ok-ink">✓</span>' : '<b class="neg" title="Does not agree with the bank">≠</b>'}</td>
          <td>${r.status === "new" ? '<a class="pend" href="#/bank?account=' + a.id + '">To match</a>' : h(r.posted_as || "")}</td></tr>`).join("")
          || '<tr><td colspan="8" class="muted">No entries in this period.</td></tr>'}</table></div>`);
    $("#flt").onsubmit = (e) => { e.preventDefault(); const f = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v)); location.hash = `#/bank/accounts/${id}` + (String(f) ? "?" + f : ""); };
    $("#exx").onclick = () => saveSheets(`bank_${String(a.name).replace(/\W+/g, "_")}_${today()}.xlsx`, [["Statement", [["Date", "Description", "Reference", "In", "Out", "Balance", "Bank's balance", "Posted as"],
      ["", "Opening balance", "", "", "", d.opening, "", ""],
      ...d.rows.map((r) => [dmy(r.txn_date), r.description, r.ref || "", Number(r.credit) || "", Number(r.debit) || "", r.running, r.balance === null ? "" : Number(r.balance), r.status === "new" ? "To match" : r.posted_as || ""])]]]);
  }

  // ---------------------------------------------------------------- expenses and other income
  async function expenses() {
    const sp = params();
    const now = new Date(); const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const from = sp.get("from") || ym + "-01", to = sp.get("to") || today();
    const d = await api("GET", `/api/expenses?from=${from}&to=${to}`);
    const editable = can("accounts", "edit");
    const out = d.byCat.filter((c) => c.direction === "out"), inc = d.byCat.filter((c) => c.direction === "in");
    const tot = (l) => l.reduce((t, c) => t + Number(c.total), 0);
    const catOpts = (dir) => '<option value="">— pick —</option>' + d.categories.filter((c) => (dir === "in" ? /income|Interest received|Owner/.test(c) : !/income|Interest received/.test(c)))
      .map((c) => `<option>${h(c)}</option>`).join("");
    layout(`
      <div class="head"><h1>🏦 Expenses &amp; other income</h1><div class="actions">
        ${editable ? '<button class="btn primary" id="addx">＋ Cash expense</button>' : ""}<button class="btn" id="exx">⬇ Excel</button><a class="btn" href="#/accounts">← Accounts</a></div></div>
      ${tabs("exp")}
      ${editable ? `<form class="card" id="xf" hidden><h3>Cash expense or income</h3>
        <p class="muted small">For money paid or received in cash. Bank entries come from the bank statement, so do not type them here as well.</p>
        <div class="form-grid">
          <label>Date <input type="date" name="day" value="${today()}" required></label>
          <label>Type <select name="direction"><option value="out">Expense (paid)</option><option value="in">Other income (received)</option></select></label>
          <label>Category <select name="category" required>${catOpts("out")}</select></label>
          <label>Amount (₹) <input name="amount" inputmode="decimal" required></label>
          <label class="full">Description <input name="description" placeholder="e.g. Courier to Pune, tea and snacks"></label></div>
        <div id="xerr"></div><div class="buttons"><button class="btn primary" id="xsave">Save</button><button type="button" class="btn" id="xcancel">Cancel</button></div></form>` : ""}
      <form class="filters" id="flt"><label>From <input type="date" name="from" value="${from}"></label><label>To <input type="date" name="to" value="${to}"></label><button class="btn">Show</button></form>
      <div class="dgrid"><div class="panel"><h3>Spent · ₹ ${money(tot(out))}</h3><table class="grid">${out.map((c) => `<tr><td>${h(c.category)}</td><td class="num">${c.n}</td><td class="num"><b>${money(c.total)}</b></td></tr>`).join("") || '<tr><td class="muted">Nothing</td></tr>'}</table></div>
        <div class="panel"><h3>Other income · ₹ ${money(tot(inc))}</h3><table class="grid">${inc.map((c) => `<tr><td>${h(c.category)}</td><td class="num">${c.n}</td><td class="num"><b>${money(c.total)}</b></td></tr>`).join("") || '<tr><td class="muted">Nothing</td></tr>'}</table></div></div>
      <div class="scroll"><table class="grid"><tr><th>Date</th><th>Category</th><th>Description</th><th>Paid by</th><th class="num">Amount</th>${editable ? "<th></th>" : ""}</tr>
        ${d.rows.map((r) => `<tr><td>${dmy(r.day)}</td><td>${h(r.category)}</td><td class="wrap">${h(r.description)}</td><td>${r.bank_line_id ? `Bank${r.account ? ` · ${h(r.account)}` : ""}` : "Cash"}</td>
          <td class="num">${r.direction === "in" ? "+" : ""}${money(r.amount)}</td>
          ${editable ? `<td>${r.bank_line_id ? "" : `<button class="btn small" data-xdel="${r.id}">🗑</button>`}</td>` : ""}</tr>`).join("")
          || '<tr><td colspan="6" class="muted">No expenses in this period. Bank ones are added from the bank statement; cash ones with ＋ Cash expense.</td></tr>'}</table></div>`);
    $("#flt").onsubmit = (e) => { e.preventDefault(); location.hash = "#/bank/expenses?" + new URLSearchParams(new FormData(e.target)); };
    $("#exx").onclick = () => saveSheets(`expenses_${from}_to_${to}.xlsx`, [
      ["Entries", [["Date", "Type", "Category", "Description", "Paid by", "Amount"], ...d.rows.map((r) => [dmy(r.day), r.direction === "in" ? "Income" : "Expense", r.category, r.description || "", r.bank_line_id ? "Bank" + (r.account ? " · " + r.account : "") : "Cash", Number(r.amount)])]],
      ["By category", [["Type", "Category", "Entries", "Total"], ...d.byCat.map((c) => [c.direction === "in" ? "Income" : "Expense", c.category, Number(c.n), Number(c.total)])]]]);
    const xf = $("#xf");
    if (xf) {
      $("#addx").onclick = () => { xf.hidden = false; $("[name=amount]", xf).focus(); };
      $("#xcancel").onclick = () => (xf.hidden = true);
      $("[name=direction]", xf).onchange = (e) => ($("[name=category]", xf).innerHTML = catOpts(e.target.value));
      xf.onsubmit = async (e) => {
        e.preventDefault();
        busy($("#xsave"), true, "Saving…");
        try { await api("POST", "/api/expenses", Object.fromEntries(new FormData(xf))); flash("Saved."); route(); }
        catch (err) { $("#xerr").innerHTML = errorBox([err.message]); busy($("#xsave"), false); }
      };
    }
    $$("[data-xdel]").forEach((b) => (b.onclick = async () => {
      if (!confirm("Delete this cash entry?")) return;
      await api("DELETE", `/api/expenses/${b.dataset.xdel}`); flash("Deleted."); route();
    }));
  }
  return { bank, accounts, accountStatement, expenses };
}
