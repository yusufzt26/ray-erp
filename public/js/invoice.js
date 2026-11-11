// Sales invoices: create from a customer PO, GST, amount in words, print in the
// company format (Original / Duplicate / Triplicate) and box labels.

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nl = (v) => h(v).replace(/\n/g, "<br>");
const money = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qtyFmt = (n) => (n === null || n === undefined ? "" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isNaN(n) ? 0 : n; };
const dmy = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- amount in words (Indian system)
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
  "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigits(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : ""); }
function threeDigits(n) {
  const hdr = Math.floor(n / 100), rest = n % 100;
  return [hdr ? ONES[hdr] + " Hundred" : "", rest ? (hdr ? "and " : "") + twoDigits(rest) : ""].filter(Boolean).join(" ");
}
export function amountInWords(amount) {
  const total = Math.round(Number(amount || 0) * 100);
  let rupees = Math.floor(total / 100);
  const paise = total % 100;
  if (rupees === 0 && paise === 0) return "Zero Only";
  const parts = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push((crore >= 100 ? threeDigits(crore) : twoDigits(crore)) + " Crore");
  if (lakh) parts.push(twoDigits(lakh) + " Lakh");
  if (thousand) parts.push(twoDigits(thousand) + " Thousand");
  if (rupees) parts.push(threeDigits(rupees));
  let words = "Rupees " + (parts.join(" ") || "Zero");
  if (paise) words += " and " + twoDigits(paise) + " Paise";
  return words + " Only";
}

export function computeTotals(lines, gstRate, taxType) {
  const sub = round2(lines.reduce((s, l) => s + num(l.amount), 0));
  const igst = taxType === "IGST" ? round2((sub * gstRate) / 100) : 0;
  const cgst = taxType === "IGST" ? 0 : round2((sub * gstRate) / 200);
  return { subtotal: sub, igst, cgst, sgst: cgst, total: round2(sub + igst + 2 * cgst) };
}

function billToFor(c) {
  if (!c) return "";
  const cityLine = [c.city, [c.state, c.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [c.name, c.address, cityLine, c.contact_person ? `Kind Attn : ${c.contact_person}${c.phone ? " - " + c.phone : ""}` : ""].filter(Boolean).join("\n");
}

import { linksPanel } from "./links.js";

// ---------------------------------------------------------------- pages
export function invoicePages(ctx) {
  const { api, layout, can, flash, $, $$, errorBox, busy } = ctx;

  async function list() {
    const qs = new URLSearchParams(location.hash.split("?")[1] || "").get("q") || "";
    const { rows } = await api("GET", "/api/invoices?" + new URLSearchParams({ q: qs }));
    layout(`
      <div class="head"><h1>Sales Invoices <small>(${rows.length})</small></h1>
        <div class="actions">${can("sales_invoice", "edit") ? '<a class="btn primary" href="#/invoices/new">＋ New Invoice</a>' : ""}</div></div>
      <form class="filters" id="flt"><input name="q" value="${h(qs)}" placeholder="Search invoice no, PO no or customer…"><button class="btn">Search</button></form>
      <div class="scroll"><table class="grid">
        <tr><th>Invoice No</th><th>Date</th><th>Customer</th><th>PO No</th><th class="num">Grand Total</th><th>Status</th></tr>
        ${rows.map((r) => `<tr class="click ${r.status === "Cancelled" ? "inactive" : ""}" data-href="#/invoices/${r.id}"><td><b>${h(r.inv_no)}</b></td>
          <td>${dmy(r.inv_date)}</td><td>${h(r.customer)}</td><td>${h(r.po_no)}</td><td class="num">${money(r.total)}</td><td><span class="pill">${h(r.status)}</span></td></tr>`).join("")
          || '<tr><td colspan="6" class="muted">No invoices yet. Open a Customer PO and press "Make Invoice", or press "New Invoice".</td></tr>'}
      </table></div>`);
    $("#flt").onsubmit = (e) => { e.preventDefault(); location.hash = "#/invoices?" + new URLSearchParams(new FormData(e.target)); };
  }

  function lineRow(l, products) {
    return `<tr>
      <td class="ln"></td>
      <td><select name="product_id" class="prod"><option value="">— pick item —</option>
        ${products.map((p) => `<option value="${p.id}" ${String(l.product_id) === String(p.id) ? "selected" : ""}>${h(p.code)} · ${h(p.name)}</option>`).join("")}</select></td>
      <td><input name="material_code" value="${h(l.material_code)}"></td>
      <td><input name="description" value="${h(l.description)}"></td>
      <td><input name="part_no" value="${h(l.part_no)}"></td>
      <td><input name="hsn" value="${h(l.hsn)}"></td>
      <td><input name="uom" value="${h(l.uom || "NOS")}"></td>
      <td><input name="qty" value="${l.qty ?? ""}" inputmode="decimal"></td>
      <td><input name="rate" value="${l.rate ?? ""}" inputmode="decimal"></td>
      <td><input name="disc" value="${l.disc ?? 0}" inputmode="decimal"></td>
      <td class="num amt">${money(l.amount)}</td>
      <td><button type="button" class="rm" title="Remove line">✕</button></td></tr>`;
  }

  async function form(id) {
    if (!can("sales_invoice", id ? "view" : "edit")) return ctx.forbidden();
    const opts = await api("GET", "/api/invoices/options");
    const { customers, products, pos } = opts;
    let inv = { inv_date: today(), gst_rate: 18, tax_type: "", status: "Issued" };
    let lines = [];
    let packing = [];
    const qp = new URLSearchParams(location.hash.split("?")[1] || "");
    const fromPo = qp.get("from") || qp.get("po");
    if (id) {
      const r = await api("GET", `/api/invoices/${id}`);
      inv = r.inv; lines = r.lines; packing = JSON.parse(inv.packing || "[]");
    } else if (fromPo) {
      Object.assign(inv, await poToInvoice(fromPo, customers));
      lines = inv._lines; delete inv._lines;
    }
    const ed = can("sales_invoice", "edit");
    const custOpt = (c) => `<option value="${c.id}" ${String(inv.customer_id) === String(c.id) ? "selected" : ""}>${h(c.name)} (${h(c.code)})</option>`;
    layout(`
      <div class="head"><h1>${id ? `Invoice <span class="code">${h(inv.inv_no)}</span>` : "New Sales Invoice"}</h1>
        <div class="actions">${id ? `<a class="btn primary" href="#/invoices/${id}/print">🖨 Print</a>` : ""}
          ${id && can("accounts", "edit") && inv.status !== "Cancelled" ? `<a class="btn" href="#/payments/new?dir=in&party=${inv.customer_id}&amount=${inv.total}&ref=${encodeURIComponent(inv.inv_no)}">💰 Record payment</a>` : ""}<a class="btn" href="#/invoices">← Back</a></div></div>
      <div id="err"></div>
      <form id="f">
      <fieldset ${ed ? "" : "disabled"}>
      ${id ? "" : `<div class="card step"><b>Step 1.</b> Pick the customer PO you are dispatching against (or skip and fill by hand).
        <select id="po_pick"><option value="">— no PO / fill by hand —</option>
          ${pos.map((p) => `<option value="${p.id}" ${String(fromPo) === String(p.id) ? "selected" : ""}>${h(p.ref_no)} · ${h(p.party_name)} · PO ${h(p.doc_no)} (${h(p.status)})</option>`).join("")}</select></div>`}
      <div class="card">
        <div class="form-grid">
          <label>Customer <span class="req">*</span><select name="customer_id" id="customer_id" required><option value="">— pick —</option>${customers.map(custOpt).join("")}</select></label>
          <label>Invoice date <span class="req">*</span><input type="date" name="inv_date" value="${h(inv.inv_date)}" required>
            <small>${id ? "" : "Invoice number is given automatically when you save"}</small></label>
          <label>PO Number<input name="po_no" value="${h(inv.po_no)}"></label>
          <label>PO Date<input type="date" name="po_date" value="${h(inv.po_date)}"></label>
          <label>Supplier Code<input name="supplier_code" value="${h(inv.supplier_code)}"><small>Our code at this customer</small></label>
          <label>Customer GSTIN<input name="gstin" class="upper" maxlength="15" value="${h(inv.gstin)}"></label>
          <label>Customer PAN<input name="pan" class="upper" maxlength="10" value="${h(inv.pan)}"></label>
          <label>Status<select name="status">${["Issued", "Cancelled"].map((s) => `<option ${inv.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <label class="half">Bill To<textarea name="bill_to" rows="5">${h(inv.bill_to)}</textarea></label>
          <label class="half">Ship To<textarea name="ship_to" rows="5">${h(inv.ship_to)}</textarea></label>
        </div>
      </div>
      <div class="card">
        <h2>Items</h2>
        <div class="scroll"><table class="lines inv-lines"><thead><tr><th>#</th><th>Item</th><th>Material Code</th><th>Description</th><th>Part No</th><th>HSN</th><th>UOM</th><th>Qty</th><th>Rate</th><th>Disc %</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody id="lines">${lines.map((l) => lineRow(l, products)).join("")}</tbody></table></div>
        ${ed ? '<button type="button" class="btn small" id="addline">＋ Add item</button>' : ""}
        <div class="inv-totals">
          <div class="form-grid">
            <label>GST rate %<input name="gst_rate" id="gst_rate" value="${inv.gst_rate ?? 18}" inputmode="decimal"></label>
            <label>Tax type<select name="tax_type" id="tax_type">
              <option value="">Auto (from GSTIN)</option>
              <option value="IGST" ${inv.tax_type === "IGST" && id ? "selected" : ""}>IGST (other state)</option>
              <option value="CGST_SGST" ${inv.tax_type === "CGST_SGST" && id ? "selected" : ""}>CGST + SGST (Maharashtra)</option></select></label>
            <label>Delivery condition<input name="delivery_condition" value="${h(inv.delivery_condition)}"></label>
            <label>Payment terms<input name="payment_terms" value="${h(inv.payment_terms)}"></label>
          </div>
          <table class="sumtable" id="sum"></table>
        </div>
      </div>
      <div class="card">
        <h2>Packing information <small class="muted">(prints on the invoice and on box labels)</small></h2>
        <table class="lines"><thead><tr><th>Box</th><th>Item line</th><th>Qty in box</th><th></th></tr></thead><tbody id="boxes"></tbody></table>
        ${ed ? '<button type="button" class="btn small" id="addbox">＋ Add box</button> <button type="button" class="btn small" id="autobox">Fill boxes automatically…</button>' : ""}
      </div>
      ${inv.customer_po_id ? `<input type="hidden" name="customer_po_id" value="${h(inv.customer_po_id)}">
        ${id ? "" : `<div class="card"><label>After saving, mark the Sales Order as
          <select name="po_status"><option value="" selected>Work it out from the quantities (recommended)</option><option>Partly Dispatched</option><option>Completed</option></select></label></div>`}` : ""}
      ${inv.challan_id ? `<input type="hidden" name="challan_id" value="${h(inv.challan_id)}">` : ""}
      </fieldset>
      ${ed ? `<div class="buttons sticky-save"><button class="btn primary big">💾 Save invoice</button></div>` : ""}
      </form>
      <div id="links"></div>
      ${id && ctx.S.user.role === "Admin" ? '<button class="btn danger small" id="del">Delete invoice</button>' : ""}`);
    if (id) linksPanel(api, "invoice", id).then((html) => { if ($("#links")) $("#links").innerHTML = html; }).catch(() => {});

    const tbody = $("#lines"), boxes = $("#boxes");
    const customer = () => customers.find((c) => String(c.id) === $("#customer_id").value);
    const lineLabels = () => $$("tr", tbody).map((r, i) => `${i + 1}. ${$("[name=part_no]", r).value || $("[name=material_code]", r).value || $("[name=description]", r).value}`);
    const taxType = () => {
      const t = $("#tax_type").value;
      if (t) return t;
      const g = ($("[name=gstin]").value || "").slice(0, 2);
      const own = (ctx.S.settings.company_gstin || "27").slice(0, 2);
      return g && g !== own ? "IGST" : "CGST_SGST";
    };
    function recalc() {
      const ls = $$("tr", tbody).map((r) => {
        const amt = round2(num($("[name=qty]", r).value) * num($("[name=rate]", r).value) * (1 - num($("[name=disc]", r).value) / 100));
        $(".amt", r).textContent = money(amt);
        return { amount: amt };
      });
      const rate = num($("#gst_rate").value);
      const t = computeTotals(ls, rate, taxType());
      $("#sum").innerHTML = `
        <tr><td>Sub Total</td><td></td><td>${money(t.subtotal)}</td></tr>
        ${taxType() === "IGST" ? `<tr><td>IGST</td><td>${rate}%</td><td>${money(t.igst)}</td></tr>`
          : `<tr><td>CGST</td><td>${rate / 2}%</td><td>${money(t.cgst)}</td></tr><tr><td>SGST</td><td>${rate / 2}%</td><td>${money(t.sgst)}</td></tr>`}
        <tr class="grand"><td>GRAND TOTAL</td><td></td><td>₹ ${money(t.total)}</td></tr>
        <tr><td colspan="3" class="muted words">${amountInWords(t.total)}</td></tr>`;
      // keep box item dropdowns in step with the lines
      const labels = lineLabels();
      $$("select[name=box_line]", boxes).forEach((s) => {
        const v = s.value;
        s.innerHTML = labels.map((lab, i) => `<option value="${i + 1}" ${String(i + 1) === v ? "selected" : ""}>${h(lab)}</option>`).join("");
      });
    }
    const renumber = () => { $$("tr", tbody).forEach((r, i) => ($(".ln", r).textContent = i + 1)); recalc(); };
    const renumberBoxes = () => $$("tr", boxes).forEach((r, i) => ($(".bn", r).textContent = `Box No ${i + 1}`));
    const addBox = (b = {}) => {
      boxes.insertAdjacentHTML("beforeend", `<tr><td class="bn"></td><td><select name="box_line">${lineLabels().map((lab, i) =>
        `<option value="${i + 1}" ${b.line === i + 1 ? "selected" : ""}>${h(lab)}</option>`).join("")}</select></td>
        <td><input name="box_qty" value="${b.qty ?? ""}" inputmode="decimal"></td><td><button type="button" class="rm">✕</button></td></tr>`);
      renumberBoxes();
    };
    if ($("#addline")) $("#addline").onclick = () => { tbody.insertAdjacentHTML("beforeend", lineRow({}, products)); renumber(); };
    if ($("#addbox")) $("#addbox").onclick = () => addBox();
    if ($("#autobox")) $("#autobox").onclick = () => {
      const per = num(prompt("How many pieces go in one box?", "1000"));
      if (!per) return;
      boxes.innerHTML = "";
      $$("tr", tbody).forEach((r, i) => {
        let left = num($("[name=qty]", r).value);
        while (left > 0) { addBox({ line: i + 1, qty: Math.min(per, left) }); left -= per; }
      });
    };
    boxes.addEventListener("click", (e) => { if (e.target.classList.contains("rm")) { e.target.closest("tr").remove(); renumberBoxes(); } });
    tbody.addEventListener("click", (e) => { if (e.target.classList.contains("rm")) { e.target.closest("tr").remove(); renumber(); } });
    tbody.addEventListener("input", recalc);
    tbody.addEventListener("change", (e) => {
      if (e.target.name !== "product_id") return;
      const r = e.target.closest("tr"), p = products.find((p) => String(p.id) === e.target.value);
      if (!p) return;
      const set = (n, v) => { if (v !== null && v !== undefined && v !== "") $(`[name=${n}]`, r).value = v; };
      set("material_code", p.customer_part_no); set("description", p.name); set("part_no", p.drawing_no);
      set("hsn", p.hsn); set("uom", p.uom); set("rate", p.sale_rate);
      recalc();
    });
    ["#gst_rate", "#tax_type", "[name=gstin]"].forEach((s) => $(s).addEventListener("input", recalc));
    $("#tax_type").addEventListener("change", recalc);
    $("#customer_id").onchange = () => {
      const c = customer();
      if (!c) return;
      const f = $("#f");
      f.bill_to.value = billToFor(c);
      f.ship_to.value = c.ship_to || billToFor(c);
      f.gstin.value = c.gstin || ""; f.pan.value = c.pan || "";
      f.supplier_code.value = c.supplier_code || "";
      f.delivery_condition.value = c.delivery_condition || "";
      f.payment_terms.value = c.payment_terms || "";
      recalc();
    };
    if ($("#po_pick")) $("#po_pick").onchange = (e) => { location.hash = e.target.value ? `#/invoices/new?po=${e.target.value}` : "#/invoices/new"; };
    if (!lines.length && ed) $("#addline").click();
    packing.forEach(addBox);
    renumber();

    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = Object.fromEntries(fd);
      body.id = id || null;
      if (!body.tax_type) body.tax_type = taxType();
      body.lines = $$("tr", tbody).map((r) => Object.fromEntries(
        ["product_id", "material_code", "description", "part_no", "hsn", "uom", "qty", "rate", "disc"].map((k) => [k, $(`[name=${k}]`, r).value])));
      body.packing = $$("tr", boxes).map((r) => ({ line: $("[name=box_line]", r).value, qty: $("[name=box_qty]", r).value }));
      const btn = e.submitter;
      busy(btn, true, "Saving…");
      try {
        const res = await api("POST", "/api/invoices/save", body);
        flash(`Invoice ${res.inv_no} saved. Press Print to get the 3 copies.`);
        location.hash = `#/invoices/${res.id}/print`;
      } catch (err) {
        busy(btn, false);
        $("#err").innerHTML = errorBox([err.message]);
        scrollTo(0, 0);
      }
    };
    if ($("#del")) $("#del").onclick = async () => {
      if (!confirm(`Delete invoice ${inv.inv_no}? The number will not be reused.`)) return;
      await api("DELETE", `/api/invoices/${id}`);
      flash("Invoice deleted.");
      location.hash = "#/invoices";
    };
  }

  async function poToInvoice(poId, customers) {
    const { po, lines, challan, party_id } = await api("GET", `/api/invoices/from-doc/${poId}`);
    const c = customers.find((c) => c.id === party_id);
    const rates = lines.map((l) => l.gst_rate).filter((r) => r !== null && r !== undefined);
    return {
      customer_id: party_id, customer_po_id: po.id, challan_id: challan?.id || null, po_no: po.doc_no, po_date: po.doc_date,
      supplier_code: c?.supplier_code || "", gstin: c?.gstin || po.party_gstin || "", pan: c?.pan || "",
      bill_to: billToFor(c) || po.party_name, ship_to: c?.ship_to || billToFor(c) || po.party_name,
      delivery_condition: c?.delivery_condition || "", payment_terms: c?.payment_terms || "",
      gst_rate: rates.length && rates.every((r) => r === rates[0]) ? rates[0] : 18,
      _lines: lines.map((l) => ({
        product_id: l.product_id, material_code: l.party_part_no || l.customer_part_no || "", description: l.description,
        part_no: l.drawing_no || "", hsn: l.hsn, uom: l.uom, qty: l.qty, rate: l.rate, disc: 0, amount: l.amount,
      })),
    };
  }

  // ---------------------------------------------------------------- print
  function invoiceHtml(inv, lines, s, copy) {
    const packing = JSON.parse(inv.packing || "[]");
    const pk = packing.map((p, i) => {
      const l = lines[p.line - 1] || {};
      return { box: `Box No ${i + 1}`, text: `${l.part_no || l.material_code || l.description || ""} - ${qtyFmt(p.qty)} Nos` };
    });
    const pkRows = [];
    for (let i = 0; i < pk.length; i += 2) pkRows.push([pk[i], pk[i + 1]]);
    const minRows = Math.max(0, 10 - lines.length);
    const igst = inv.tax_type === "IGST";
    return `<div class="inv-page">
    <table class="inv">
      <colgroup><col style="width:5%"><col style="width:13%"><col style="width:27%"><col style="width:10%"><col style="width:6%"><col style="width:9%"><col style="width:9%"><col style="width:6%"><col style="width:15%"></colgroup>
      <tr class="b"><td colspan="3">${h(copy)}</td><td colspan="4" class="c small">(U/S 31 of CGST Act &amp; SGST Act R.W.Sec. 20 of IGST Act)</td><td colspan="2" class="c">GST Tax Invoice</td></tr>
      <tr><td colspan="4" class="logo-cell"><img src="/logo.png" alt="Ray Precicomp"><div class="tag">${nl(s.company_tagline)}</div></td>
        <td colspan="5" class="from"><b>M/S ${h(s.company_name)}</b><br>${nl(s.company_address)}<br>Email: ${h(s.company_email)}<br>Mobile: ${h(s.company_mobile)}</td></tr>
      <tr><td colspan="2"><b>GSTIN : ${h(s.company_gstin)}</b></td><td colspan="2">W.E.F. ${h(s.company_gst_wef)}</td>
        <td colspan="3">State Code : ${h(s.company_state)}</td><td colspan="2">PAN No. ${h(s.company_pan)}</td></tr>
      <tr class="hl"><td colspan="2">Invoice No. :</td><td colspan="2"><b>${h(inv.inv_no)}</b></td><td colspan="3">Invoice Date :</td><td colspan="2" class="c"><b>${dmy(inv.inv_date)}</b></td></tr>
      <tr class="hl"><td colspan="2">PO Number</td><td><b>${h(inv.po_no)}</b></td><td>PO Date: <b>${dmy(inv.po_date)}</b></td><td colspan="3">Supplier Code :</td><td colspan="2" class="c"><b>${h(inv.supplier_code)}</b></td></tr>
      <tr class="addr"><td colspan="4"><b>Bill To :</b><br>${nl(inv.bill_to)}</td><td colspan="5"><b>Ship To :</b><br>${nl(inv.ship_to)}</td></tr>
      <tr class="hl"><td colspan="2">GSTIN : <b>${h(inv.gstin)}</b></td><td colspan="2">PAN : <b>${h(inv.pan)}</b></td><td colspan="5">GSTIN : <b>${h(inv.gstin)}</b></td></tr>
      <tr class="th"><td>S No</td><td>MATERIAL CODE</td><td>DESCRIPTION</td><td>HSN</td><td>UOM</td><td>Qty</td><td>Rate</td><td>Disc</td><td>AMOUNT</td></tr>
      ${lines.map((l, i) => `<tr class="item"><td class="c">${i + 1}</td><td class="c">${h(l.material_code)}</td><td>${h(l.description)}</td><td class="c">${h(l.hsn)}</td>
        <td class="c">${h(l.uom)}</td><td class="c">${qtyFmt(l.qty)}</td><td class="r">${money(l.rate)}</td><td class="c">${l.disc ? qtyFmt(l.disc) + "%" : "0"}</td><td class="r">${money(l.amount)}</td></tr>`).join("")}
      ${Array.from({ length: minRows }, () => '<tr class="item empty"><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>').join("")}
      <tr><td colspan="2" rowspan="2">Total Value in Words :</td><td colspan="3" rowspan="2"><b>${amountInWords(inv.total)}</b></td><td colspan="2"><b>Sub Total</b></td><td></td><td class="r"><b>${money(inv.subtotal)}</b></td></tr>
      <tr><td colspan="2"><b>SGST</b></td><td class="c">${igst ? "" : inv.gst_rate / 2 + "%"}</td><td class="r">${igst ? "" : money(inv.sgst)}</td></tr>
      <tr><td colspan="2">Delivery Condition :</td><td colspan="3">${h(inv.delivery_condition)}</td><td colspan="2"><b>CGST</b></td><td class="c">${igst ? "" : inv.gst_rate / 2 + "%"}</td><td class="r">${igst ? "" : money(inv.cgst)}</td></tr>
      <tr><td colspan="2">Payment Terms :</td><td colspan="3">${h(inv.payment_terms)}</td><td colspan="2"><b>IGST</b></td><td class="c">${igst ? inv.gst_rate + "%" : ""}</td><td class="r">${igst ? money(inv.igst) : ""}</td></tr>
      <tr class="grand"><td colspan="5"><b>Packing Information</b></td><td colspan="3"><b>GRAND TOTAL</b></td><td class="r"><b>${money(inv.total)}</b></td></tr>
      ${pkRows.map(([a, b]) => `<tr><td colspan="2">${h(a.box)}</td><td colspan="2">${h(a.text)}</td><td colspan="2">${h(b?.box || "")}</td><td colspan="3">${h(b?.text || "")}</td></tr>`).join("")}
      <tr><td colspan="9" class="decl">${h(s.invoice_declaration)}</td></tr>
      <tr class="foot"><td colspan="4"><b>TERMS &amp; CONDITIONS :</b><br>${nl(s.invoice_terms)}<br><b>BANK DETAILS:</b><br>${nl(s.bank_details)}</td>
        <td colspan="2" class="c bottom">Receiver's<br>Signature/Mob No</td>
        <td colspan="3" class="c sign"><b>For ${h(s.company_name)}</b><div class="gap"></div>Authorised Signatory</td></tr>
    </table></div>`;
  }

  function labelsHtml(inv, lines, s) {
    const packing = JSON.parse(inv.packing || "[]");
    if (!packing.length) return '<p class="muted noprint">No boxes entered on this invoice.</p>';
    return `<div class="labels">${packing.map((p, i) => {
      const l = lines[p.line - 1] || {};
      return `<table class="label"><tr><th colspan="2">${h(s.company_name)} - Packing List</th></tr>
        <tr><td>Material Code</td><td><b>${h(l.material_code)}</b></td></tr>
        <tr><td>Description</td><td>${h(l.description)}</td></tr>
        <tr><td>Part No</td><td><b>${h(l.part_no)}</b></td></tr>
        <tr><td>Quantity</td><td><b>${qtyFmt(p.qty)}</b></td></tr>
        <tr><td>Box No</td><td><b>${i + 1} of ${packing.length}</b></td></tr>
        <tr><td>Invoice</td><td>${h(inv.inv_no)} · ${dmy(inv.inv_date)}</td></tr></table>`;
    }).join("")}</div>`;
  }

  async function print(id) {
    const { inv, lines } = await api("GET", `/api/invoices/${id}`);
    const s = ctx.S.settings;
    const mode = new URLSearchParams(location.hash.split("?")[1] || "").get("show") || "invoice";
    const copies = ["ORIGINAL FOR RECIPIENT", "DUPLICATE COPY", "TRIPLICATE COPY"];
    layout(`
      <div class="head noprint"><h1>Invoice <span class="code">${h(inv.inv_no)}</span> ${inv.status === "Cancelled" ? '<span class="pill">Cancelled</span>' : ""}</h1>
        <div class="actions">
          <a class="btn ${mode === "invoice" ? "primary" : ""}" href="#/invoices/${id}/print">Invoice (3 copies)</a>
          <a class="btn ${mode === "labels" ? "primary" : ""}" href="#/invoices/${id}/print?show=labels">Box labels</a>
          <button class="btn primary" onclick="window.print()">🖨 Print / Save PDF</button>
          ${can("sales_invoice", "edit") ? `<a class="btn" href="#/invoices/${id}">✏️ Edit</a>` : ""}
          <a class="btn" href="#/invoices">← Back</a></div></div>
      <p class="muted noprint">Tip: in the print window choose "Save as PDF" to email it. Paper size A4.</p>
      <div class="print-area">${mode === "labels" ? labelsHtml(inv, lines, s) : copies.map((c) => invoiceHtml(inv, lines, s, c)).join("")}</div>`);
  }

  return { list, form, print };
}
