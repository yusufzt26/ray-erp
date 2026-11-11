// "Linked documents" strip shown on every document and invoice.
const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dmy = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const money = (n) => (n === null || n === undefined ? "" : "₹ " + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });

export async function linksPanel(api, kind, id, onProgress) {
  const { items, progress } = await api("GET", `/api/links/${kind}/${id}`);
  if (onProgress && progress) onProgress(progress);
  const chain = items.length > 1 ? `<div class="chain">${items.map((it, i) => `${i ? '<span class="arrow">→</span>' : ""}
    <a class="link-card ${it.current ? "current" : ""}" href="${it.href}"><small>${h(it.label)}</small><b>${h(it.ref)}</b>
      ${it.no ? `<small>${h(it.no)}</small>` : ""}<small>${dmy(it.day)} · ${h(it.status)}${it.amount ? ` · ${money(it.amount)}` : ""}</small></a>`).join("")}</div>`
    : '<p class="muted small">Nothing linked yet. Use the buttons at the top to make the next document.</p>';
  const prog = progress && progress.length ? `<div class="scroll"><table class="grid mini"><tr><th>Item</th><th class="num">Ordered</th><th class="num">Done</th><th class="num">Pending</th></tr>
    ${progress.map((l) => `<tr><td>${h(l.description)}</td><td class="num">${qty(l.qty)} ${h(l.uom || "")}</td><td class="num">${qty(l.done)}</td>
      <td class="num"><b class="${l.pending > 0 ? "pend" : "ok-ink"}">${l.pending > 0 ? qty(l.pending) : "✓ done"}</b></td></tr>`).join("")}</table></div>` : "";
  return `<div class="card links"><h2>Linked documents</h2>${chain}${prog}</div>`;
}

// "Paid ₹X · Balance ₹Y" strip for a sales invoice (dir in) or vendor bill (dir out).
export async function payStatus(api, dir, id) {
  const { bill, payments } = await api("GET", `/api/bills/${dir}/${id}`);
  if (!bill) return "";
  const cls = bill.pay_status === "Paid" ? "ok" : bill.pay_status === "Part paid" ? "warn" : "";
  const list = payments.map((p) => `${dmy(p.pay_date)} ${h(p.mode || "")} ${h(p.reference || "")} ${money(p.amount)}`).join(" · ");
  return `<div class="card paystat"><span class="pill ${cls}">${h(bill.pay_status)}</span>
    Total <b>${money(bill.total)}</b> · ${dir === "in" ? "Received" : "Paid"} <b>${money(bill.paid)}</b> · Balance <b class="${bill.balance > 0.5 ? "pend" : "ok-ink"}">${money(Math.max(0, bill.balance))}</b>
    ${list ? `<br><small class="muted">Payments: ${list}</small>` : ""}${bill.auto > 0.5 ? `<br><small class="muted">${money(bill.auto)} matched from payments not tied to a bill (oldest bills first).</small>` : ""}</div>`;
}
