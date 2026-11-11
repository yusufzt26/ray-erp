// E-way bill: builds the file for "Bulk Generation" on ewaybillgst.gov.in from an invoice or delivery challan,
// and keeps the transport details and the e-way bill number on the document.

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const dmy = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");

const STATE_CODES = {
  "jammu and kashmir": 1, "himachal pradesh": 2, punjab: 3, chandigarh: 4, uttarakhand: 5, haryana: 6, delhi: 7, rajasthan: 8,
  "uttar pradesh": 9, bihar: 10, sikkim: 11, "arunachal pradesh": 12, nagaland: 13, manipur: 14, mizoram: 15, tripura: 16,
  meghalaya: 17, assam: 18, "west bengal": 19, jharkhand: 20, odisha: 21, chhattisgarh: 22, "madhya pradesh": 23, gujarat: 24,
  "dadra and nagar haveli and daman and diu": 26, maharashtra: 27, karnataka: 29, goa: 30, lakshadweep: 31, kerala: 32,
  "tamil nadu": 33, puducherry: 34, "andaman and nicobar islands": 35, telangana: 36, "andhra pradesh": 37, ladakh: 38,
};
const gstinOk = (g) => /^\d{2}[A-Z0-9]{13}$/.test(String(g || "").toUpperCase());
const stateCode = (gstin, state) => {
  if (gstinOk(gstin)) return Number(String(gstin).slice(0, 2));
  const s = String(state || "").trim();
  if (/^\d{1,2}\b/.test(s)) return Number(s.match(/^\d{1,2}/)[0]);
  return STATE_CODES[s.toLowerCase()] || null;
};
const pinIn = (text) => (String(text || "").match(/\b[1-9]\d{5}\b/g) || []).pop() || "";

// Unit codes the portal accepts.
const UQC = { NOS: "NOS", NO: "NOS", NUMBERS: "NOS", PCS: "PCS", PC: "PCS", PIECES: "PCS", MTR: "MTR", M: "MTR", MTRS: "MTR", METER: "MTR", METERS: "MTR",
  KG: "KGS", KGS: "KGS", SET: "SET", SETS: "SET", BOX: "BOX", ROL: "ROL", ROLL: "ROL", PAC: "PAC", PACK: "PAC", LTR: "LTR", GMS: "GMS", BAG: "BAG", BDL: "BDL" };

export const REASONS = [
  [1, "Supply (sale)"], [4, "Job work"], [6, "Job work returns"], [7, "Sales return"], [5, "For own use"], [12, "Exhibition or fairs"], [8, "Others"],
];
export const MODES = [[1, "Road"], [2, "Rail"], [3, "Air"], [4, "Ship"]];

/** Splits an address into two portal lines (120 characters each) and a place name. */
function addrParts(text, city) {
  const flat = String(text || "").split(/\n/).map((x) => x.trim()).filter(Boolean).join(", ");
  const pin = pinIn(flat);
  const noPin = flat.replace(pin, "").replace(/[\s,-]+$/, "");
  const cut = noPin.length > 100 ? noPin.lastIndexOf(",", 100) : -1;
  const a1 = (cut > 20 ? noPin.slice(0, cut) : noPin.slice(0, 100)).trim();
  const a2 = noPin.slice(a1.length).replace(/^[\s,]+/, "").slice(0, 120);
  const place = city || (noPin.split(/[,\s]+/).filter((w) => /^[A-Za-z]{3,}$/.test(w)).pop() || "");
  return { a1, a2, place, pin };
}

/**
 * kind: "invoice" | "delivery_challan". rec: { doc, lines, party } from /api/eway. s: company settings.
 * e: transport details. Returns { file, summary, problems }.
 */
export function buildEway(kind, rec, s, e) {
  const { doc, lines, party } = rec;
  const problems = [];
  const isInv = kind === "invoice";
  const reason = isInv ? 1 : Number(e.reason || 1);
  const ourGstin = String(s.company_gstin || "").toUpperCase();
  const from = addrParts(s.company_address);
  const ourState = stateCode(ourGstin, s.company_state);

  const toGstinRaw = String((isInv ? doc.gstin : doc.party_gstin) || party?.gstin || "").toUpperCase().replace(/\s/g, "");
  const toGstin = gstinOk(toGstinRaw) ? toGstinRaw : "URP";
  const partyAddr = party?.address || (isInv ? String(doc.bill_to || "").split("\n").slice(1).join("\n") : "");
  const to = addrParts(partyAddr, party?.city);
  const shipPin = isInv ? pinIn(doc.ship_to) : pinIn(party?.ship_to);
  const toPin = shipPin || party?.pincode || to.pin;
  const toState = stateCode(toGstin === "URP" ? "" : toGstin, party?.state);

  // Tax: an invoice carries its own; a challan for supply works it out, other challans carry no tax.
  const sameState = ourState && toState && ourState === toState;
  const igstMode = isInv ? doc.tax_type === "IGST" : !sameState;
  const taxable = isInv || reason === 1;
  const items = lines.filter((l) => Number(l.qty) || Number(l.amount)).map((l, i) => {
    const rate = !taxable ? 0 : isInv ? Number(doc.gst_rate || 0) : Number(l.product_gst ?? 18);
    const amt = r2(l.amount ?? Number(l.qty || 0) * Number(l.rate || 0));
    const hsn = String(l.hsn || "").replace(/\D/g, "");
    if (!hsn) problems.push(`Line ${i + 1} (${l.description || l.part_no || "item"}) has no HSN code.`);
    const unit = UQC[String(l.uom || "NOS").toUpperCase().replace(/[^A-Z]/g, "")] || "OTH";
    return {
      itemNo: i + 1,
      productName: String(l.product_name || l.description || l.part_no || "").slice(0, 100),
      productDesc: String(l.description || l.product_name || "").slice(0, 100),
      hsnCode: Number(hsn) || 0,
      quantity: Number(l.qty || 0),
      qtyUnit: unit,
      taxableAmount: amt,
      sgstRate: igstMode ? 0 : rate / 2, cgstRate: igstMode ? 0 : rate / 2, igstRate: igstMode ? rate : 0,
      cessRate: 0, cessNonAdvol: 0,
    };
  });
  const totalValue = r2(items.reduce((t, x) => t + x.taxableAmount, 0));
  let cgst, sgst, igst;
  if (isInv) { cgst = r2(doc.cgst); sgst = r2(doc.sgst); igst = r2(doc.igst); }
  else {
    const tax = r2(items.reduce((t, x) => t + (x.taxableAmount * (x.igstRate + x.cgstRate + x.sgstRate)) / 100, 0));
    igst = igstMode ? tax : 0; cgst = igstMode ? 0 : r2(tax / 2); sgst = igstMode ? 0 : r2(tax - cgst);
  }
  const totInv = isInv ? r2(doc.total) : r2(totalValue + cgst + sgst + igst);
  const docNo = String(isInv ? doc.inv_no : doc.ref_no || doc.doc_no || "");
  const docDate = isInv ? doc.inv_date : doc.doc_date;

  if (!gstinOk(ourGstin)) problems.push("Our GSTIN is missing in Settings.");
  if (!from.pin) problems.push("Our address in Settings has no 6-digit PIN code.");
  if (!party) problems.push("No customer is linked to this document.");
  if (toGstin === "URP" && toGstinRaw) problems.push(`Customer GSTIN "${toGstinRaw}" does not look right, so it will go as unregistered.`);
  if (!toPin) problems.push("Customer PIN code is missing. Add it on the customer.");
  if (!toState) problems.push("Customer state is missing. Add the GSTIN or state on the customer.");
  if (!items.length) problems.push("There are no items.");
  if (docNo.length > 16) problems.push(`Document number "${docNo}" is longer than the 16 characters the portal allows.`);
  const vehicle = String(e.vehicle_no || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const mode = Number(e.mode || 1);
  const transporterId = String(e.transporter_id || "").toUpperCase().trim();
  if (mode === 1 && !vehicle && !transporterId) problems.push("Enter the vehicle number (or the transporter ID if they will add the vehicle).");
  if (vehicle && !/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(vehicle) && !/^TMP|^TR/.test(vehicle)) problems.push(`Vehicle number "${vehicle}" does not look like a normal number, e.g. MH14AB1234.`);
  if (mode !== 1 && !e.trans_doc_no) problems.push("For rail, air or ship enter the transport document (RR / airway bill / bill of lading) number.");
  const distance = Math.round(Number(e.distance || 0));
  if (distance > 4000) problems.push("Distance looks too large (more than 4,000 km).");

  const bill = {
    userGstin: ourGstin,
    supplyType: "O",
    subSupplyType: reason,
    subSupplyDesc: reason === 8 ? "Others" : "",
    docType: isInv ? "INV" : "CHL",
    docNo,
    docDate: dmy(docDate),
    transType: 1,
    fromGstin: ourGstin,
    fromTrdName: String(s.company_name || "").slice(0, 100),
    fromAddr1: from.a1, fromAddr2: from.a2, fromPlace: from.place.slice(0, 50),
    fromPincode: Number(from.pin) || 0,
    fromStateCode: ourState || 0, actualFromStateCode: ourState || 0,
    toGstin,
    toTrdName: String(party?.name || doc.party_name || "").slice(0, 100),
    toAddr1: to.a1, toAddr2: to.a2, toPlace: (party?.city || to.place).slice(0, 50),
    toPincode: Number(toPin) || 0,
    toStateCode: toState || 0, actualToStateCode: toState || 0,
    totalValue, cgstValue: cgst, sgstValue: sgst, igstValue: igst, cessValue: 0,
    TotNonAdvolVal: 0, OthValue: r2(totInv - totalValue - cgst - sgst - igst), totInvValue: totInv,
    transMode: mode,
    transDistance: distance,
    transporterName: String(e.transporter_name || "").slice(0, 100),
    transporterId,
    transDocNo: String(e.trans_doc_no || "").slice(0, 15),
    transDocDate: dmy(e.trans_doc_date),
    vehicleNo: vehicle,
    vehicleType: "R",
    mainHsnCode: items[0]?.hsnCode || 0,
    itemList: items,
  };
  if (Math.abs(bill.OthValue) < 0.01) bill.OthValue = 0;
  return {
    file: { version: "1.0.0621", billLists: [bill] },
    summary: { docNo, docDate, from, to, toPin, toGstin, toState, ourState, totalValue, cgst, sgst, igst, totInv, items, igstMode },
    problems,
  };
}

export async function ewayPage({ api, layout, S, can, flash, $, errorBox, busy }, kind, id) {
  const isInv = kind === "invoice";
  const mod = isInv ? "sales_invoice" : "delivery_challan";
  const rec = await api("GET", `/api/eway/${kind}/${id}`);
  const e = { mode: "1", reason: "1", distance: rec.party?.distance_km ?? "", ...(rec.doc.eway || {}) };
  const back = isInv ? `#/invoices/${id}` : `#/d/delivery_challan/${id}`;
  const edit = can(mod, "edit");
  const opt = (list, v) => list.map(([k, label]) => `<option value="${k}" ${String(v) === String(k) ? "selected" : ""}>${h(label)}</option>`).join("");

  layout(`
    <div class="head"><h1>🚛 E-way bill <span class="code">${h(isInv ? rec.doc.inv_no : rec.doc.ref_no)}</span></h1>
      <div class="actions"><a class="btn" href="${back}">← Back</a></div></div>
    ${e.ewb_no ? `<div class="flash ok">E-way bill <b>${h(e.ewb_no)}</b>${e.ewb_date ? ` dated ${dmy(e.ewb_date)}` : ""} is saved on this ${isInv ? "invoice" : "challan"} and prints on it.</div>` : ""}
    <div id="err"></div>
    <form id="f" class="card">
      <h2>1. Transport details</h2>
      <div class="form-grid">
        ${isInv ? "" : `<label>Reason for moving goods <select name="reason">${opt(REASONS, e.reason)}</select></label>`}
        <label>Mode <select name="mode">${opt(MODES, e.mode)}</select></label>
        <label>Vehicle number <input name="vehicle_no" class="upper" value="${h(e.vehicle_no)}" placeholder="MH14AB1234"></label>
        <label>Distance (km) <input name="distance" inputmode="numeric" value="${h(e.distance)}" placeholder="0 = portal works it out">
          <small>Road distance. Saved on the customer for next time.</small></label>
        <label>Transporter ID / GSTIN <input name="transporter_id" class="upper" value="${h(e.transporter_id)}" placeholder="optional"></label>
        <label>Transporter name <input name="transporter_name" value="${h(e.transporter_name)}"></label>
        <label>LR / RR / airway bill no <input name="trans_doc_no" value="${h(e.trans_doc_no)}"></label>
        <label>LR date <input type="date" name="trans_doc_date" value="${h(e.trans_doc_date)}"></label>
      </div>
      <div id="sum"></div>
      ${edit ? `<div class="buttons"><button class="btn primary" id="dl">⬇ Download e-way bill file</button>
        <a class="btn" href="https://ewaybillgst.gov.in" target="_blank" rel="noopener">Open e-way bill portal ↗</a></div>` : ""}
      <p class="muted">On the portal: log in → <b>e-Waybill</b> → <b>Bulk Generation</b> → choose the downloaded file → <b>Upload</b> → <b>Generate</b>.
        The portal shows the 12-digit e-way bill number. Enter it below.</p>
    </form>
    <form id="n" class="card narrow2">
      <h2>2. E-way bill number from the portal</h2>
      <div class="form-grid">
        <label>E-way bill no <input name="ewb_no" inputmode="numeric" maxlength="14" value="${h(e.ewb_no)}" placeholder="12 digits"></label>
        <label>Date <input type="date" name="ewb_date" value="${h(e.ewb_date || new Date().toISOString().slice(0, 10))}"></label>
      </div>
      ${edit ? '<div class="buttons"><button class="btn primary">Save number</button></div>' : ""}
    </form>`);

  const form = $("#f");
  const current = () => Object.fromEntries(new FormData(form));
  const show = () => {
    const { summary: m, problems } = buildEway(kind, rec, S.settings, current());
    $("#sum").innerHTML = `
      <h2>What goes in the file</h2>
      <div class="scroll"><table class="grid"><tbody>
        <tr><th>From</th><td>${h(S.settings.company_name)}, ${h(m.from.place)} ${h(m.from.pin)} · state ${h(m.ourState)}</td></tr>
        <tr><th>To</th><td>${h(rec.party?.name || "")} · GSTIN ${h(m.toGstin)} · PIN ${h(m.toPin)} · state ${h(m.toState)}${rec.party ? ` · <a href="#/m/customers/${rec.party.id}">edit customer</a>` : ""}</td></tr>
        <tr><th>Items</th><td>${m.items.map((x) => `${h(x.productName)} · HSN ${x.hsnCode || "—"} · ${x.quantity} ${x.qtyUnit} · ₹ ${money(x.taxableAmount)}`).join("<br>")}</td></tr>
        <tr><th>Value</th><td>₹ ${money(m.totalValue)} + ${m.igstMode ? `IGST ₹ ${money(m.igst)}` : `CGST ₹ ${money(m.cgst)} + SGST ₹ ${money(m.sgst)}`} = <b>₹ ${money(m.totInv)}</b></td></tr>
      </tbody></table></div>
      ${problems.length ? `<div class="flash error"><b>Fix before uploading:</b><br>${problems.map(h).join("<br>")}</div>`
        : '<div class="flash ok">Everything the portal needs is filled in.</div>'}
      ${m.totInv <= 50000 ? '<p class="muted">Value is ₹ 50,000 or less: an e-way bill is usually not required (job-work moves across states are an exception).</p>' : ""}`;
  };
  form.oninput = show;
  form.onchange = show;
  show();

  const save = (body) => api("PUT", `/api/eway/${kind}/${id}`, body);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $("#dl");
    busy(btn, true, "Preparing…");
    try {
      const body = current();
      const { file, problems } = buildEway(kind, rec, S.settings, body);
      await save(body);
      const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `EWB_${file.billLists[0].docNo.replace(/[^A-Za-z0-9-]/g, "_")}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      $("#err").innerHTML = problems.length ? errorBox(["File downloaded, but the portal will reject it until these are fixed:", ...problems])
        : '<div class="flash ok">File downloaded. Now upload it on the portal (Bulk Generation).</div>';
    } catch (err) { $("#err").innerHTML = errorBox([err.message]); }
    busy(btn, false);
  };
  $("#n").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await save({ ...current(), ...Object.fromEntries(new FormData(ev.target)) });
      flash("E-way bill number saved. It now prints on the document.");
      location.hash = back;
    } catch (err) { $("#err").innerHTML = errorBox([err.message]); scrollTo(0, 0); }
  };
}
