// Type-ahead for document lines: typing 1-2 letters, a part no, or a short form (initials, e.g. "fpa" for
// "Fuel Pipe Assembly") in Part No or Description lists matching products and lines from earlier documents.
const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const compact = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** How well `q` matches an option (0 = not at all). */
export function score(q, o) {
  const qc = compact(q), qw = words(q);
  if (!qc) return 0;
  const codes = [o.part, o.code, o.drawing].map(compact).filter(Boolean);
  let best = 0;
  for (const c of codes) {
    if (c.startsWith(qc)) best = Math.max(best, 100);
    else if (qc.length >= 3 && c.includes(qc)) best = Math.max(best, 50);
  }
  const w = words(o.name);
  if (w.length) {
    if (w[0].startsWith(qw[0] || "") && qw.every((x) => w.some((y) => y.startsWith(x)))) best = Math.max(best, 90);
    else if (qw.every((x) => w.some((y) => y.startsWith(x)))) best = Math.max(best, 70);
    const initials = w.filter((y) => /^[a-z]/.test(y)).map((y) => y[0]).join("");
    if (qc.length >= 2 && /^[a-z]+$/.test(qc) && initials.startsWith(qc)) best = Math.max(best, 80);
    else if (qc.length >= 2 && /^[a-z]+$/.test(qc) && initials.includes(qc)) best = Math.max(best, 40);
    if (qc.length >= 3 && compact(o.name).includes(qc)) best = Math.max(best, 30);
  }
  return best;
}

/**
 * opts: { products, recent, rateKey: "sale_rate" | "purchase_rate", onPick(row, option) }
 * Options from products carry the product id; earlier lines carry only text and the last rate.
 */
export function attachSuggest(tbody, { products = [], recent = [], rateKey, onPick }) {
  const seen = new Set();
  const options = [];
  for (const p of products) {
    options.push({ id: p.id, code: p.code, part: p.customer_part_no, drawing: p.drawing_no, name: p.name, hsn: p.hsn, uom: p.uom, rate: p[rateKey], gst: p.gst_rate });
    seen.add(compact(p.name) + "|" + compact(p.customer_part_no));
  }
  for (const r of recent) {
    const k = compact(r.description) + "|" + compact(r.party_part_no);
    if (seen.has(k)) continue;
    seen.add(k);
    options.push({ part: r.party_part_no, name: r.description, hsn: r.hsn, uom: r.uom, rate: r.rate, gst: r.gst_rate, earlier: true });
  }

  document.querySelectorAll(".suggest").forEach((b) => b.remove()); // one list at a time, even if the page was drawn twice
  const box = document.createElement("div");
  box.className = "suggest";
  box.hidden = true;
  box.setAttribute("role", "listbox");
  document.body.appendChild(box);
  let input = null, list = [], at = -1;

  const close = () => { box.hidden = true; list = []; at = -1; };
  const paint = () => {
    box.innerHTML = list.map((o, i) => `<div class="sg ${i === at ? "on" : ""}" data-i="${i}" role="option">
      <span>${o.code ? `<b>${esc(o.code)}</b> · ` : ""}${o.part ? `<span class="sgpart">${esc(o.part)}</span> · ` : ""}${esc(o.name)}</span>
      <small>${o.earlier ? "used before" : "product"}${o.rate ? ` · ₹${esc(o.rate)}` : ""}</small></div>`).join("");
  };
  const open = (el) => {
    input = el;
    const q = el.value.trim();
    list = q ? options.map((o) => [score(q, o), o]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 8).map(([, o]) => o) : [];
    if (!list.length) return close();
    at = -1;
    paint();
    const r = el.getBoundingClientRect();
    box.style.left = `${r.left + scrollX}px`;
    box.style.top = `${r.bottom + scrollY + 2}px`;
    box.style.minWidth = `${Math.max(r.width, 320)}px`;
    box.hidden = false;
  };
  const pick = (o) => { const row = input.closest("tr"); close(); onPick(row, o); };

  const isField = (el) => el?.matches?.("[name=party_part_no], [name=description]");
  tbody.addEventListener("input", (e) => { if (isField(e.target)) open(e.target); });
  tbody.addEventListener("keydown", (e) => {
    if (!isField(e.target) || box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = (at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      paint();
    } else if (e.key === "Enter" && at >= 0) { e.preventDefault(); pick(list[at]); }
    else if (e.key === "Escape") close();
  });
  tbody.addEventListener("focusout", () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150));
  box.addEventListener("mousedown", (e) => {
    const d = e.target.closest("[data-i]");
    if (d) { e.preventDefault(); pick(list[Number(d.dataset.i)]); }
  });
  // The box lives on <body>; remove it when the page is redrawn.
  window.addEventListener("hashchange", () => box.remove(), { once: true });
}
