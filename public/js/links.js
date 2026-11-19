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

// Setup period: tie this document to the earlier one it came from (old entries made before the chain existed).
const LABEL = { quotation: "Quotation", customer_po: "Sales Order", delivery_challan: "Delivery Challan", purchase_order: "Purchase Order", grn: "Goods Receipt" };
export async function linkOldPanel(api, kind, id, el, { canEdit, onDone }) {
  const r = await api("GET", `/api/link-old/${kind}/${id}`);
  if (!canEdit || !r.types.length || !el || (!r.open && !r.current_doc)) return;
  const what = r.types.map((t) => LABEL[t]).join(" or ");
  const cur = r.current_doc ? `<p class="small">Linked to <b>${h(LABEL[r.current_doc.doc_type] || "")} ${h(r.current_doc.ref_no)}</b>.
      <button type="button" class="btn small danger" id="lo_unlink">✕ Unlink</button>
      <small class="muted">Removes only the link: both documents stay, and pending quantities and statuses are worked out again.</small></p>` : "";
  if (!r.open) {
    el.innerHTML = `<div class="card linkold"><h2>🔗 Link</h2>${cur}<small id="lo_msg"></small></div>`;
  } else el.innerHTML = `<div class="card linkold"><h2>🔗 Link to an earlier ${h(what)}</h2>${cur}
    <p class="muted small">For entries made before the documents were linked. Open until ${dmy(r.until)} (Company Settings).</p>
    ${r.candidates.length ? `<div class="row"><select id="lo_pick"><option value="">— not linked —</option>
      ${r.candidates.map((c) => `<option value="${c.id}" ${c.id === r.current ? "selected" : ""}>${h(LABEL[c.doc_type])} ${h(c.ref_no)}${c.doc_no && c.doc_no !== c.ref_no ? ` · ${h(c.doc_no)}` : ""} · ${dmy(c.doc_date)} · ${h(c.status)}${c.total_amount ? ` · ${money(c.total_amount)}` : ""}</option>`).join("")}
      </select><button type="button" class="btn small primary" id="lo_save">Save link</button></div><small id="lo_msg"></small>`
      : `<p class="muted small">No ${h(what)} for this party${kind === "invoice" ? " with the same customer PO number" : ""} yet. Enter the old one first, then link it here.</p>`}
    ${kind === "invoice" ? '<small class="muted">Only sales orders with the same customer PO number as this invoice are listed.</small>' : ""}</div>`;
  const un = el.querySelector("#lo_unlink");
  if (un) un.onclick = async () => {
    un.disabled = true;
    try {
      const res = await api("POST", `/api/link-old/${kind}/${id}`, { parent_id: null });
      el.querySelector("#lo_msg").textContent = res.message;
      un.closest("p").remove();
      if (el.querySelector("#lo_pick")) el.querySelector("#lo_pick").value = "";
      if (onDone) onDone();
    } catch (err) { el.querySelector("#lo_msg").textContent = err.message; un.disabled = false; }
  };
  const btn = el.querySelector("#lo_save");
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try {
      const res = await api("POST", `/api/link-old/${kind}/${id}`, { parent_id: el.querySelector("#lo_pick").value || null });
      el.querySelector("#lo_msg").textContent = res.message;
      if (onDone) onDone();
    } catch (err) { el.querySelector("#lo_msg").textContent = err.message; }
    btn.disabled = false;
  };
}

// "Paid ₹X · Balance ₹Y" strip for a sales invoice (dir in) or vendor bill (dir out).
export async function payStatus(api, dir, id) {
  const { bill, payments } = await api("GET", `/api/bills/${dir}/${id}`);
  if (!bill) return "";
  const cls = bill.pay_status === "Paid" ? "ok" : bill.pay_status === "Part paid" ? "warn" : "";
  const list = payments.map((p) => `${dmy(p.pay_date)} ${h(p.mode || "")} ${h(p.reference || "")} ${money(p.amount)}`).join(" · ");
  return `<div class="card paystat"><span class="pill ${cls}">${h(bill.pay_status)}</span>
    Total <b>${money(bill.total)}</b> · ${dir === "in" ? "Received" : "Paid"} <b>${money(bill.paid)}</b> · Balance <b class="${bill.balance > 0.5 ? "pend" : "ok-ink"}">${money(Math.max(0, bill.balance))}</b>
    ${list ? `<br><small class="muted">Payments: ${list}</small>` : ""}${bill.advance > 0.5 ? `<br><small class="muted">${money(bill.advance)} adjusted from the advance against the order.</small>` : ""}${bill.auto > 0.5 ? `<br><small class="muted">${money(bill.auto)} matched from payments not tied to a bill (oldest bills first).</small>` : ""}</div>`;
}
