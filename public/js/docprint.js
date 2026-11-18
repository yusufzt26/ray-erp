// A4 print for quotations, sales orders, delivery challans, purchase orders and GRNs.
import { DOC_TYPES, gstTotals } from "./fields.js";
import { amountInWords } from "./invoice.js";
import { fitPages, pdfName } from "./printfit.js";

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nl = (v) => h(v).replace(/\n/g, "<br>");
const dmy = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const deliveryLine = (type, doc) => {
  const n = doc.delivery_days;
  if (n !== null && n !== undefined) return `<b>Delivery in :</b> ${n} day${n === 1 ? "" : "s"}<br>`;
  return doc.delivery_date ? `<b>Delivery by :</b> ${dmy(doc.delivery_date)}<br>` : "";
};
const money = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (n) => (n === null || n === undefined ? "" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));

export async function docPrint({ api, layout, S }, type, id) {
  const d = DOC_TYPES[type];
  const { doc, lines } = await api("GET", `/api/d/${type}/${id}`);
  let party = null;
  if (doc.party_id) party = await api("GET", `/api/m/${d.partyMaster}/${doc.party_id}`).then((r) => r.row).catch(() => null);
  const s = S.settings;
  const priced = type !== "grn";
  const cityLine = party ? [party.city, [party.state, party.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  const partyBlock = [party?.name || doc.party_name, party?.address, cityLine, party?.contact_person ? `Kind Attn : ${party.contact_person}${party.phone ? " - " + party.phone : ""}` : ""].filter(Boolean).join("\n");
  const sub = lines.reduce((t, l) => t + Number(l.amount || 0), 0);
  const total = Number(doc.total_amount || sub);
  // GST rows: CGST + SGST for the same state, IGST for another state; older documents show one tax line.
  const rates = [...new Set(lines.filter((l) => Number(l.amount)).map((l) => Number(l.gst_rate ?? 18)))];
  const one = rates.length === 1 ? rates[0] : null;
  // Several GST rates: one row per rate, when the saved tax is what the rates give (not typed by hand).
  const byRate = rates.map((r) => [r, gstTotals(lines.filter((l) => Number(l.gst_rate ?? 18) === r), doc.tax_type)]);
  const asCalc = rates.length > 1 && Math.abs(byRate.reduce((t, [, g]) => t + g.tax, 0) - (Number(doc.cgst || 0) + Number(doc.sgst || 0) + Number(doc.igst || 0))) < 0.01;
  const taxRows = !doc.tax_type ? [["GST / Tax", total - sub]]
    : asCalc ? byRate.flatMap(([r, g]) => doc.tax_type === "IGST" ? [[`IGST @ ${r}%`, g.igst]] : [[`CGST @ ${r / 2}%`, g.cgst], [`SGST @ ${r / 2}%`, g.sgst]])
    : doc.tax_type === "IGST" ? [[`IGST${one !== null ? ` @ ${one}%` : ""}`, doc.igst]]
    : [[`CGST${one !== null ? ` @ ${one / 2}%` : ""}`, doc.cgst], [`SGST${one !== null ? ` @ ${one / 2}%` : ""}`, doc.sgst]];
  const other = doc.tax_type ? Math.round((total - sub - taxRows.reduce((t, r) => t + Number(r[1] || 0), 0)) * 100) / 100 : 0;
  if (Math.abs(other) >= 0.01) taxRows.push(["Round off / other", other]);
  const blanks = Math.max(0, 6 - lines.length);
  const cols = priced ? 8 : 6;
  layout(`
    <div class="head noprint"><h1>${h(d.singular)} <span class="code">${h(doc.ref_no)}</span></h1>
      <div class="actions"><button class="btn primary" onclick="window.print()">🖨 Print / Save PDF</button>
        <a class="btn" href="#/d/${type}/${id}">← Back</a></div></div>
    <p class="muted noprint">Tip: in the print window choose "Save as PDF" to email it. Paper size A4.</p>
    <div class="print-area" data-pdf-name="${h(pdfName(doc.ref_no, party?.name || doc.party_name))}"><div class="inv-page">
      <table class="inv">
        <colgroup>${priced ? '<col style="width:5%"><col style="width:16%"><col style="width:33%"><col style="width:10%"><col style="width:9%"><col style="width:7%"><col style="width:9%"><col style="width:11%">'
          : '<col style="width:6%"><col style="width:20%"><col style="width:44%"><col style="width:12%"><col style="width:10%"><col style="width:8%">'}</colgroup>
        <tr class="b"><td colspan="${cols}" class="c" style="font-size:13pt">${h(d.printTitle || d.singular.toUpperCase())}</td></tr>
        <tr><td colspan="${priced ? 4 : 3}" class="logo-cell"><img src="/logo.png" alt=""><div class="tag">${nl(s.company_tagline)}</div></td>
          <td colspan="${priced ? 4 : 3}" class="from"><b>M/S ${h(s.company_name)}</b><br>${nl(s.company_address)}<br>Email: ${h(s.company_email)}<br>Mobile: ${h(s.company_mobile)}
            <br><b>GSTIN : ${h(s.company_gstin)}</b> · PAN ${h(s.company_pan)}</td></tr>
        <tr class="hl"><td colspan="2">${h(d.own ? d.noLabel : "Our Ref")}</td><td><b>${h(doc.ref_no)}</b></td>
          <td colspan="${priced ? 2 : 1}">Date</td><td colspan="${priced ? 3 : 2}"><b>${dmy(doc.doc_date)}</b></td></tr>
        ${doc.eway?.ewb_no || doc.eway?.vehicle_no ? `<tr><td colspan="2">E-way Bill No</td><td><b>${h(doc.eway.ewb_no || "")}</b>${doc.eway.ewb_date ? " dt " + dmy(doc.eway.ewb_date) : ""}</td>
          <td colspan="${priced ? 2 : 1}">Vehicle No</td><td colspan="${priced ? 3 : 2}"><b>${h(doc.eway.vehicle_no || "")}</b></td></tr>` : ""}
        ${!d.own && doc.doc_no ? `<tr><td colspan="2">${h(d.noLabel)}</td><td colspan="${cols - 2}"><b>${h(doc.doc_no)}</b></td></tr>` : ""}
        <tr class="addr"><td colspan="${priced ? 4 : 3}"><b>${type === "purchase_order" || type === "grn" ? "To / Supplier" : "To"} :</b><br>${nl(partyBlock)}</td>
          <td colspan="${priced ? 4 : 3}">${doc.party_gstin ? `<b>GSTIN :</b> ${h(doc.party_gstin)}<br>` : ""}${deliveryLine(type, doc)}</td></tr>
        <tr class="th"><td>S No</td><td>Part No</td><td>Description</td><td>HSN</td><td>Qty</td><td>UOM</td>${priced ? "<td>Rate</td><td>Amount</td>" : ""}</tr>
        ${lines.map((l, i) => `<tr class="item"><td class="c">${i + 1}</td><td>${h(l.party_part_no)}</td><td>${h(l.description)}</td><td class="c">${h(l.hsn)}</td>
          <td class="r">${qty(l.qty)}</td><td class="c">${h(l.uom)}</td>${priced ? `<td class="r">${money(l.rate)}</td><td class="r">${money(l.amount)}</td>` : ""}</tr>`).join("")}
        ${'<tr class="item empty">' + "<td></td>".repeat(cols) + "</tr>"}${("<tr class=\"item empty\">" + "<td></td>".repeat(cols) + "</tr>").repeat(blanks)}
        ${doc.notes ? `<tr class="notes"><td colspan="${cols}"><b>Notes :</b> ${nl(doc.notes)}</td></tr>` : ""}
        ${priced ? `<tr class="grand"><td colspan="5" rowspan="${taxRows.length + 2}"><b>Amount in words :</b><br>${h(amountInWords(total))}</td><td colspan="2">Taxable value</td><td class="r">${money(sub)}</td></tr>
          ${taxRows.map(([k, v]) => `<tr><td colspan="2">${h(k)}</td><td class="r nw">${money(v)}</td></tr>`).join("")}
          <tr class="b"><td colspan="2">Total</td><td class="r nw">${money(total)}</td></tr>`
          : `<tr class="grand"><td colspan="4"><b>Total quantity</b></td><td class="r"><b>${qty(lines.reduce((t, l) => t + Number(l.qty || 0), 0))}</b></td><td></td></tr>`}
        <tr class="foot"><td colspan="${priced ? 5 : 3}">${type === "quotation" || type === "customer_po" || (type === "purchase_order" && (doc.terms || s.po_terms)) ? `<b>TERMS &amp; CONDITIONS :</b><br>${nl(type === "quotation" ? doc.terms || s.quotation_terms || s.invoice_terms : type === "purchase_order" ? doc.terms || s.po_terms : s.invoice_terms)}` : type === "grn" ? "<b>Received in good condition.</b><br>Checked by :" : "<b>Receiver's signature &amp; stamp</b>"}</td>
          <td colspan="${priced ? 3 : 3}" class="c sign"><b>For ${h(s.company_name)}</b><div class="gap"></div>Authorised Signatory</td></tr>
      </table></div></div>`);
  fitPages();
}
