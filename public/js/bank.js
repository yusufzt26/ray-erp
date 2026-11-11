// Bank statement: upload the bank's Excel/CSV, match money in/out to invoices and vendor bills,
// and post the rest (charges, salaries, taxes...) as expenses.

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
  const tabs = (on) => `<div class="tabs">
    <a class="${on === "new" ? "on" : ""}" href="#/bank">To match</a><a class="${on === "done" ? "on" : ""}" href="#/bank?status=done">Done</a>
    <a class="${on === "exp" ? "on" : ""}" href="#/bank/expenses">Expenses &amp; other income</a></div>`;

  async function bank() {
    const status = new URLSearchParams(location.hash.split("?")[1] || "").get("status") === "done" ? "done" : "new";
    const d = await api("GET", `/api/bank?status=${status}`);
    const editable = can("accounts", "edit");
    const party = (dir, id) => (dir === "in" ? d.customers : d.vendors).find((c) => c.id === id);
    const opts = (list, sel) => '<option value="">— pick —</option>' + list.map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${h(c.name)}</option>`).join("");
    const catOpts = (credit, sel) => '<option value="">— pick —</option>' + d.categories
      .filter((c) => (credit ? /income|Interest received|Owner|Transfer/.test(c) : !/income|Interest received/.test(c)))
      .map((c) => `<option ${c === sel ? "selected" : ""}>${h(c)}</option>`).join("");

    layout(`
      <div class="head"><h1>🏦 Bank statement</h1><div class="actions"><a class="btn" href="#/accounts">← Accounts</a></div></div>
      ${tabs(status)}
      ${editable && status === "new" ? `<div class="card">
        <label><b>Upload the bank statement</b> (Excel or CSV downloaded from net banking)
          <input type="file" id="file" accept=".xls,.xlsx,.csv"></label>
        <p class="muted small">Entries already uploaded are skipped, so you can upload an overlapping period safely.
          For each entry the app suggests the customer or vendor and the invoices it settles, or what kind of expense it is. Check and press <b>Post</b>.</p>
        <div id="up"></div></div>` : ""}
      <div id="err"></div>
      ${status === "new" ? `
        ${d.lines.length ? `<div class="scroll"><table class="grid bank">
          <tr><th><input type="checkbox" id="all" checked></th><th>Date</th><th>Description</th><th class="num">In</th><th class="num">Out</th><th>Post as</th><th>Details</th></tr>
          ${d.lines.map((l) => row(l)).join("")}</table></div>
          ${editable ? '<div class="buttons"><button class="btn primary" id="post">✓ Post ticked entries</button></div>' : ""}`
        : '<p class="muted">Nothing waiting. Upload a statement to start.</p>'}`
      : `<div class="scroll"><table class="grid"><tr><th>Date</th><th>Description</th><th class="num">In</th><th class="num">Out</th><th>Posted as</th>${editable ? "<th></th>" : ""}</tr>
          ${d.lines.map((l) => `<tr><td>${dmy(l.txn_date)}</td><td class="wrap">${h(l.description)}</td><td class="num">${l.credit ? money(l.credit) : ""}</td>
            <td class="num">${l.debit ? money(l.debit) : ""}</td><td>${h(l.posted_as)}</td>
            ${editable ? `<td><button class="btn small" data-undo="${l.id}">Undo</button></td>` : ""}</tr>`).join("") || '<tr><td colspan="6" class="muted">Nothing posted yet.</td></tr>'}</table></div>`}`);

    function row(l) {
      const s = l.suggest || {};
      const credit = Number(l.credit) > 0;
      const dir = credit ? "in" : "out";
      const kinds = [["", "— choose —"], [dir, credit ? "Received from customer" : "Paid to vendor"], ["expense", credit ? "Other income" : "Expense / charges"], ["ignore", "Ignore"]];
      if (s.kind === "link") kinds.splice(1, 0, ["link", "Already entered"]);
      return `<tr data-id="${l.id}" data-dir="${dir}" data-amt="${credit ? l.credit : l.debit}">
        <td><input type="checkbox" name="tick" ${s.kind ? "checked" : ""}></td><td>${dmy(l.txn_date)}</td>
        <td class="wrap">${h(l.description)}${l.ref ? `<br><small class="muted">${h(l.ref)}</small>` : ""}</td>
        <td class="num">${credit ? `<b>${money(l.credit)}</b>` : ""}</td><td class="num">${credit ? "" : `<b>${money(l.debit)}</b>`}</td>
        <td><select name="kind">${kinds.map(([k, t]) => `<option value="${k}" ${k === (s.kind || "") ? "selected" : ""}>${t}</option>`).join("")}</select>
          ${s.why ? `<br><small class="muted">${h(s.why)}</small>` : ""}</td>
        <td class="det" data-payment="${s.payment_id || ""}" data-party="${s.party_id || ""}" data-cat="${h(s.category || "")}"
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
          <small class="${tied === amount ? "ok-ink" : "pend"}">${tied === amount ? "✓ Settles bills exactly" : `Against bills ₹ ${money(tied)} · advance ₹ ${money(amount - tied)}`}</small>` : ""}`;
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

    const file = $("#file");
    if (file) file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: false });
        const rows = readStatement(XLSX, wb);
        if (!rows.length) { $("#up").innerHTML = errorBox(["No entries found. The file needs columns for date, description, and withdrawal / deposit (or amount with Dr/Cr). Please download the statement as Excel or CSV."]); return; }
        const res = await api("POST", "/api/bank/upload", { rows, file: f.name });
        flash(`${res.added} new entries loaded${res.skipped ? `, ${res.skipped} already there or empty skipped` : ""}.`);
        route();
      } catch (err) { $("#up").innerHTML = errorBox([err.message]); }
    };
    const post = $("#post");
    if (post) post.onclick = async () => {
      const items = $$("table.bank tr[data-id]").filter((tr) => $("[name=tick]", tr).checked && $("[name=kind]", tr).value).map((tr) => {
        const det = $(".det", tr), kind = $("[name=kind]", tr).value;
        return { id: Number(tr.dataset.id), kind, party_id: Number(det.dataset.party) || null, payment_id: Number(det.dataset.payment) || null,
          category: det.dataset.cat || "", allocations: JSON.parse(det.dataset.alloc || "[]") };
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
    $$("[data-undo]").forEach((b) => (b.onclick = async () => { await api("POST", `/api/bank/undo/${b.dataset.undo}`, {}); flash("Entry is back in To match."); route(); }));
  }

  async function expenses() {
    const sp = new URLSearchParams(location.hash.split("?")[1] || "");
    const now = new Date(); const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const from = sp.get("from") || ym + "-01", to = sp.get("to") || new Date().toISOString().slice(0, 10);
    const d = await api("GET", `/api/expenses?from=${from}&to=${to}`);
    const out = d.byCat.filter((c) => c.direction === "out"), inc = d.byCat.filter((c) => c.direction === "in");
    const tot = (l) => l.reduce((t, c) => t + Number(c.total), 0);
    layout(`
      <div class="head"><h1>🏦 Expenses &amp; other income</h1><div class="actions"><a class="btn" href="#/accounts">← Accounts</a></div></div>
      ${tabs("exp")}
      <form class="filters" id="flt"><label>From <input type="date" name="from" value="${from}"></label><label>To <input type="date" name="to" value="${to}"></label><button class="btn">Show</button></form>
      <div class="dgrid"><div class="panel"><h3>Spent · ₹ ${money(tot(out))}</h3><table class="grid">${out.map((c) => `<tr><td>${h(c.category)}</td><td class="num">${c.n}</td><td class="num"><b>${money(c.total)}</b></td></tr>`).join("") || '<tr><td class="muted">Nothing</td></tr>'}</table></div>
        <div class="panel"><h3>Other income · ₹ ${money(tot(inc))}</h3><table class="grid">${inc.map((c) => `<tr><td>${h(c.category)}</td><td class="num">${c.n}</td><td class="num"><b>${money(c.total)}</b></td></tr>`).join("") || '<tr><td class="muted">Nothing</td></tr>'}</table></div></div>
      <div class="scroll"><table class="grid"><tr><th>Date</th><th>Category</th><th>Description</th><th class="num">Amount</th></tr>
        ${d.rows.map((r) => `<tr><td>${dmy(r.day)}</td><td>${h(r.category)}</td><td class="wrap">${h(r.description)}</td><td class="num">${r.direction === "in" ? "+" : ""}${money(r.amount)}</td></tr>`).join("")
          || '<tr><td colspan="4" class="muted">No expenses in this period. They are added from the bank statement.</td></tr>'}</table></div>`);
    $("#flt").onsubmit = (e) => { e.preventDefault(); location.hash = "#/bank/expenses?" + new URLSearchParams(new FormData(e.target)); };
  }
  return { bank, expenses };
}
