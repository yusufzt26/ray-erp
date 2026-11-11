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
