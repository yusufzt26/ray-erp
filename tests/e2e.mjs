// Browser test against a running server: node tests/e2e.mjs [baseUrl]
// (start one first with: node scripts/dev-server.mjs)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = createRequire(import.meta.url)("playwright");
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const U = process.argv[2] || "http://localhost:8888";
const SHOTS = process.env.SHOTS || tmpdir();
const sample = (f) => new URL(`../samples/${f}`, import.meta.url).pathname;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("dialog", (d) => (d.type() === "prompt" ? d.accept("1000") : d.accept()));
let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error("FAIL:", msg); } else console.log("ok:", msg); };

await p.goto(U);
await p.waitForSelector("[name=username]");
await p.fill("[name=username]", "admin"); await p.fill("[name=password]", "admin123"); await p.click("button");
await p.waitForSelector("text=Welcome");
ok(await p.isVisible("text=default admin password"), "default password warning");
await p.screenshot({ path: join(SHOTS, "dash_empty.png") });

await p.goto(U + "/#/m/products/new"); await p.waitForSelector("[name=name]");
await p.fill("[name=name]", "Nylon Fuel Line Assy 8x10 L=450"); await p.fill("[name=customer_part_no]", "SAC-FL-0812");
await p.fill("[name=drawing_no]", "BR20658"); await p.fill("[name=hsn]", "87089900"); await p.fill("[name=gst_rate]", "18");
await p.click("button[name=save]");
await p.waitForSelector("text=FG-00001 created");
ok(true, "product created with FG-00001");

// CSV import
const dir = mkdtempSync(join(tmpdir(), "erp-"));
writeFileSync(join(dir, "p.csv"), "Code,Product Name,Category,Sellable,Purchasable,Unit (UOM),HSN Code\n,PA12 Tube 8x10 Black,RM,No,Yes,MTR,39173100\n,Quick Connector 8mm,BO,,yes,NOS,\n,,RM,,yes,NOS,\n");
await p.goto(U + "/#/m/products/import"); await p.waitForSelector("input[type=file]");
await p.setInputFiles("input[type=file]", join(dir, "p.csv")); await p.click("#f button");
await p.waitForSelector("text=Import result");
const rep = await p.textContent("#report");
ok(rep.includes("RM-00001") && rep.includes("BO-00001") && /2\s*added/.test(rep), "CSV import");
// importing again without codes updates the same items (matched by material code or same name), never adds twice
writeFileSync(join(dir, "p2.csv"), "Code,Product Name,Customer Material Code / Part No,Category,Unit (UOM),Purchase Rate,Active\n,PA12 Tube 8x10 Black,,RM,MTR,23,\n,Nylon Fuel Line Assy 8x10 L=450 rev B,SAC-FL-0812,FG,NOS,,\n,Old Part Nobody Has,,FG,NOS,,No\n");
await p.goto(U + "/#/"); await p.waitForSelector(".kpis");
await p.goto(U + "/#/m/products/import"); await p.waitForSelector("input[type=file]");
await p.setInputFiles("input[type=file]", join(dir, "p2.csv")); await p.click("#f button");
await p.waitForSelector("text=Import result");
{
  const rep2 = await p.textContent("#report");
  const all = (await p.evaluate(async () => (await fetch("/api/m/products?show=all")).json())).rows;
  ok(/0\s*added/.test(rep2) && /2\s*updated/.test(rep2) && rep2.includes("no matching item to mark inactive"), "re-import matches existing items " + rep2.replace(/\s+/g, " ").slice(0, 120));
  const fg1 = all.find((r) => r.code === "FG-00001"), rm1 = all.find((r) => r.code === "RM-00001");
  ok(fg1.name === "Nylon Fuel Line Assy 8x10 L=450 rev B" && fg1.drawing_no === "BR20658" && Number(rm1.purchase_rate) === 23 && rm1.hsn === "39173100", "matched items updated, empty cells kept");
  await p.evaluate(async () => fetch("/api/m/products/import", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ray-erp" },
    body: JSON.stringify({ rows: [{ code: "FG-00001", name: "Nylon Fuel Line Assy 8x10 L=450" }] }) }));
}
const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#tx")]);
ok(dl.suggestedFilename() === "products_template.xlsx", "excel template download");

// PO upload
await p.goto(U + "/#/d/customer_po/upload"); await p.waitForSelector("#drop");
await p.setInputFiles("#file", sample("sample_customer_po.pdf"));
await p.waitForSelector("text=Read from PDF", { timeout: 20000 });
ok(await p.inputValue("[name=doc_no]") === "SAC/PO/2526/0457", "PO number read");
ok(await p.inputValue("[name=doc_date]") === "2026-11-05", "PO date read");
ok((await p.$$("#lines tr")).length === 3, "3 lines read");
ok(await p.inputValue("#lines tr:first-child [name=product_id]") === "1", "line 1 matched to FG-00001");
await p.screenshot({ path: join(SHOTS, "po_review.png"), fullPage: true });
await p.click("button.primary:has-text('Save')");
await p.waitForSelector("text=CPO-00001 saved", { timeout: 15000 });
const body = await p.textContent("main");
ok(body.includes("New customer CUS-0001") && body.includes("FG-00002"), "saved with new customer and products");

// the same PO as Excel and as a scanned photo: read into the form (not saved)
const cpoUrl = p.url();
for (const [f, label] of [["sample_customer_po.xlsx", "Read from Excel"], ["sample_customer_po_scan.jpg", "by text recognition"]]) {
  await p.goto(U + "/#/"); await p.waitForSelector(".kpis");
  await p.goto(U + "/#/d/customer_po/upload"); await p.waitForSelector("#drop");
  await p.setInputFiles("#file", sample(f));
  await p.waitForSelector(`.detect:has-text("${label}")`, { timeout: 90000 });
  const xl = f.endsWith(".xlsx");
  ok(await p.inputValue("[name=doc_no]") === (xl ? "SAC/PO/2526/0458" : "SAC/PO/2526/0457"), `${f}: PO number read`);
  ok(await p.inputValue("[name=doc_date]") === (xl ? "2026-11-06" : "2026-11-05"), `${f}: PO date read`);
  ok(await p.inputValue("[name=party_id]") !== "", `${f}: customer matched by GSTIN`);
  const rows = await p.$$eval("#lines tr", (rs) => rs.map((r) => ["qty", "rate", "amount"].map((n) => Number(r.querySelector(`[name=${n}]`).value))));
  ok(JSON.stringify(rows) === (xl ? "[[400,142.5,57000],[1000,3.25,3250]]" : "[[500,142.5,71250],[300,118,35400],[2000,3.25,6500]]"), `${f}: item lines read ${JSON.stringify(rows)}`);
  ok(await p.inputValue("#lines tr:first-child [name=product_id]") === "1", `${f}: line 1 matched to our item`);
  await p.screenshot({ path: join(SHOTS, `po_review_${xl ? "excel" : "photo"}.png`), fullPage: true });
}

// invoice from PO
await p.goto(cpoUrl); await p.waitForSelector("text=Make Invoice");
await p.click("text=Make Invoice");
await p.waitForSelector("text=Step 1.");
ok(await p.inputValue("[name=po_no]") === "SAC/PO/2526/0457", "invoice prefilled from PO");
ok((await p.$$("#lines tr")).length === 3, "invoice has 3 lines");
await p.click("#autobox");
ok((await p.$$("#boxes tr")).length === 4, "auto boxes: 500 + 300 + 2x1000");
ok((await p.textContent("#sum")).includes("CGST"), "same state (27) -> CGST+SGST");
await p.screenshot({ path: join(SHOTS, "invoice_form.png"), fullPage: true });
await p.click("button:has-text('Save invoice')");
await p.waitForSelector("text=R/26-005 saved", { timeout: 15000 });
ok(await p.isVisible("text=ORIGINAL FOR RECIPIENT"), "print view shows original copy");
const words = await p.textContent(".inv-page");
ok(words.includes("Rupees One Lakh Thirty Three Thousand Five Hundred and Seventeen Only"), "amount in words");
await p.screenshot({ path: join(SHOTS, "invoice_print.png"), fullPage: false });
await p.emulateMedia({ media: "print" });
await p.pdf({ path: join(SHOTS, "invoice.pdf"), format: "A4", printBackground: true });
await p.emulateMedia({ media: "screen" });
await p.click("text=Box labels");
await p.waitForSelector("table.label");
ok((await p.$$("table.label")).length === 4, "4 box labels");

// vendor invoice
await p.goto(U + "/#/m/vendors/new"); await p.waitForSelector("[name=name]");
await p.fill("[name=name]", "Polytube Extrusions LLP"); await p.fill("[name=gstin]", "27aaffp5555q1zk"); await p.click("button[name=save]");
await p.waitForSelector("text=VEN-0001 created");
await p.goto(U + "/#/d/vendor_invoice/upload"); await p.waitForSelector("#drop");
await p.setInputFiles("#file", sample("sample_vendor_invoice.pdf"));
await p.waitForSelector("text=Read from PDF", { timeout: 20000 });
ok(await p.isVisible("text=Vendor (by GSTIN)"), "vendor matched by GSTIN");
ok(await p.inputValue("#lines tr:first-child [name=product_id]") !== "", "RM tube matched by name");

await p.click("button.primary:has-text('Save')");
await p.waitForSelector("text=VIN-00001 saved", { timeout: 15000 });
ok(true, "vendor invoice saved");

// stock
const stockOf = (id) => p.evaluate(async (id) => (await (await fetch("/api/stock")).json()).rows.find((r) => r.id === id), id);
const fg0 = await stockOf(1);
ok(Number(fg0.dispatched) > 0, "sales invoice takes stock out");
const rm0 = await stockOf(2);
ok(Number(rm0.received) > 0, "vendor invoice adds stock");
await p.goto(U + "/#/stock/entry"); await p.waitForSelector("text=Opening stock");
await p.selectOption("#l1 tr:first-child [name=product_id]", "1");
await p.fill("#l1 tr:first-child [name=qty]", "5000");
await p.click("button:has-text('Save entry')");
await p.waitForSelector("text=Stock entry saved");
ok(Number((await stockOf(1)).balance) === 5000 - Number(fg0.dispatched), "opening stock added");
await p.goto(U + "/#/m/products/1"); await p.waitForSelector("text=Material used per piece");
await p.selectOption("#bomlines tr:first-child [name=component_id]", "2"); await p.fill("#bomlines tr:first-child [name=qty_per]", "0.45");
await p.click("text=Save material list"); await p.waitForSelector("text=Material list saved");
await p.screenshot({ path: join(SHOTS, "product_bom.png"), fullPage: true });
ok(true, "material per piece saved");
await p.goto(U + "/#/stock/entry"); await p.waitForSelector("text=Production done");
await p.click("text=Production done");
await p.selectOption("#l1 tr:first-child [name=product_id]", "1"); await p.fill("#l1 tr:first-child [name=qty]", "100");
ok(await p.inputValue("#l2 tr:first-child [name=qty]") === "45" && await p.inputValue("#l2 tr:first-child [name=product_id]") === "2", "production works out 45 MTR used for 100 pcs");
await p.screenshot({ path: join(SHOTS, "stock_entry.png"), fullPage: true });
await p.click("button:has-text('Save entry')");
await p.waitForSelector("text=Stock entry saved");
ok(Number((await stockOf(2)).balance) === Number(rm0.balance) - 45, "production uses up raw material");
await p.screenshot({ path: join(SHOTS, "stock.png"), fullPage: true });
await p.goto(U + "/#/stock/1"); await p.waitForSelector("text=in stock now");
ok((await p.textContent("main")).includes("Dispatched") && (await p.textContent("main")).includes("Production"), "item stock history");
await p.screenshot({ path: join(SHOTS, "stock_item.png"), fullPage: true });

// sales register
await p.goto(U + "/#/sales-register"); await p.waitForSelector("text=Total sales");
ok((await p.textContent("main")).includes("1,13,150.00"), "sales register taxable value");
await p.screenshot({ path: join(SHOTS, "sales_register.png"), fullPage: true });
const [dl2] = await Promise.all([p.waitForEvent("download"), p.click("#exx")]);
ok(dl2.suggestedFilename().startsWith("sales_register_"), "sales register excel");

// accounts
await p.goto(U + "/#/accounts"); await p.waitForSelector("text=To collect from customers");
ok((await p.textContent("main")).includes("1,33,517.00"), "receivable shows invoice total");
await p.goto(U + "/#/payments/new?dir=in&party=1"); await p.waitForSelector("text=Which invoices does this payment settle");
await p.fill("[name=amount]", "33517"); await p.fill("[name=reference]", "UTR123");
await p.click("button:has-text('Save payment')");
await p.waitForSelector("text=Payment saved");
ok((await p.textContent("main")).includes("1,00,000.00"), "statement balance after payment");
await p.screenshot({ path: join(SHOTS, "statement.png"), fullPage: true });
{
  ok((await p.textContent("main")).includes("Invoice-wise status") && /Part paid|Paid/.test(await p.textContent("main")), "statement shows invoice-wise paid status");
  const bj = async () => p.evaluate(async () => (await fetch("/api/bills/in?party=1")).json());
  const before = (await bj()).rows;
  const target = before.filter((b) => b.balance > 0.5).pop();
  await p.goto(U + `/#/payments/new?dir=in&party=1&bill=${target.id}&ref=${encodeURIComponent(target.ref)}`);
  await p.waitForSelector(`tr[data-id="${target.id}"] [name=tick]:checked`);
  ok(Number(await p.inputValue("[name=amount]")) === target.balance, "payment from an invoice pre-fills its balance");
  await p.screenshot({ path: join(SHOTS, "payment_bills.png"), fullPage: true });
  await p.click("button:has-text('Save payment')"); await p.waitForSelector("text=Payment saved");
  const after = (await bj()).rows.find((b) => b.id === target.id);
  ok(after.pay_status === "Paid" && after.direct === after.total, "payment tied to the invoice marks it Paid");
  await p.goto(U + "/#/invoices"); await p.waitForSelector("text=Sales Invoices");
  ok((await p.textContent("main")).includes("Paid"), "invoice list shows payment status");
  {
    const open = (await bj()).rows.filter((b) => b.balance > 0.5);
    if (open.length) {
      const t = open[open.length - 1];
      await p.goto(U + "/#/payments/new?dir=in&party=1"); await p.waitForSelector("text=Which invoices does this payment settle");
      await p.fill("[name=amount]", String(t.balance));
      await p.waitForSelector("#suggest .flash");
      ok((await p.textContent("#suggest")).includes(t.ref) && await p.isChecked(`tr[data-id="${t.id}"] [name=tick]`), "typing an amount suggests and ticks the matching invoice");
    } else ok(true, "no open invoice left to suggest");
  }
  await p.goto(U + "/#/payments"); await p.waitForSelector("text=Against");
  ok((await p.textContent("main")).includes(target.ref), "payments list shows which invoice was paid");
}
await p.goto(U + "/#/accounts?tab=pay"); await p.waitForSelector("text=To pay to vendors");
ok((await p.textContent("main")).includes("Polytube"), "payable lists vendor");
await p.screenshot({ path: join(SHOTS, "accounts.png"), fullPage: true });

// linked documents: quotation -> sales order -> challan -> invoice; PO -> GRN -> vendor invoice
const getJ = (path) => p.evaluate(async (u) => (await fetch(u)).json(), path);
const statusOf = async (type, id) => (await getJ(`/api/d/${type}/${id}`)).doc.status;
await p.goto(U + "/#/d/quotation/new"); await p.waitForSelector("text=New Quotation"); await p.waitForSelector("#party_id");
await p.selectOption("#party_id", "1");
await p.selectOption("#lines tr:first-child [name=product_id]", "1");
await p.fill("#lines tr:first-child [name=qty]", "100"); await p.fill("#lines tr:first-child [name=rate]", "10");
await p.fill("[name=total_amount]", "1180");
await p.selectOption("[name=segment]", "NPD");
await p.click("button:has-text('Save Quotation')");
await p.waitForSelector("text=QTN-00001 saved");
ok(true, "quotation saved with automatic number");
await p.click("text=Make Sales Order"); await p.waitForSelector("text=only the quantity still pending");
await p.fill("[name=doc_no]", "SO-TEST-1");
await p.click("button:has-text('Save Sales Order')"); await p.waitForSelector("text=CPO-00002 saved");
const soId = Number(p.url().split("/").pop());
ok((await getJ("/api/d/quotation/" + (soId - 1))).doc.status === "Accepted" || (await p.textContent("#links")).includes("QTN-00001"), "quotation -> sales order in 1 click, quotation accepted");
await p.click("text=Make Delivery Challan"); await p.waitForSelector("text=only the quantity still pending");
ok(await p.inputValue("#lines tr:first-child [name=qty]") === "100", "challan pre-filled with pending qty");
await p.fill("#lines tr:first-child [name=qty]", "60");
await p.click("button:has-text('Save Delivery Challan')"); await p.waitForSelector("text=DC-00001 saved");
const dcId = Number(p.url().split("/").pop());
ok(await statusOf("customer_po", soId) === "Partly Dispatched", "sales order partly dispatched after challan");
await p.click("text=Make Invoice"); await p.waitForSelector("text=New Sales Invoice"); await p.waitForSelector("#lines tr");
ok(await p.inputValue("#lines tr:first-child [name=qty]") === "60", "invoice from challan pre-filled");
await p.click("button:has-text('Save invoice')"); await p.waitForSelector("text=R/26-006 saved", { timeout: 15000 });
ok(await statusOf("delivery_challan", dcId) === "Invoiced", "challan marked invoiced");
await p.goto(U + "/#/d/customer_po/" + soId); await p.waitForSelector("text=Linked documents");
await p.waitForSelector(".link-card");
const chainTxt = await p.textContent("#links");
ok(["QTN-00001", "CPO-00002", "DC-00001", "R/26-006"].every((t) => chainTxt.includes(t)) && chainTxt.includes("40"), "linked documents chain + pending 40");
await p.waitForSelector("#lines .prog");
ok((await p.textContent("#lines")).includes("Pending 40") && (await p.textContent("#lines")).includes("Dispatched 60"), "sales order items show dispatched and pending qty");
await p.screenshot({ path: join(SHOTS, "doc_links.png"), fullPage: true });
await p.click("text=Make Invoice"); await p.waitForSelector("text=New Sales Invoice"); await p.waitForSelector("#lines tr");
ok(await p.inputValue("#lines tr:first-child [name=qty]") === "40", "invoice from sales order takes only the balance");
await p.click("button:has-text('Save invoice')"); await p.waitForSelector("text=R/26-007 saved", { timeout: 15000 });
ok(await statusOf("customer_po", soId) === "Completed", "sales order completed");
{
  const npdSO = (await getJ("/api/d/customer_po?segment=NPD")).rows.map((r) => r.id);
  const regSO = (await getJ("/api/d/customer_po?segment=Regular")).rows.map((r) => r.id);
  const npdInv = (await getJ("/api/invoices?segment=NPD")).rows.map((r) => r.inv_no);
  ok(npdSO.includes(soId) && !regSO.includes(soId), "NPD tag carried from quotation to sales order, list filter works");
  ok(npdInv.includes("R/26-006") && npdInv.includes("R/26-007") && (await statusOf("delivery_challan", dcId)) && (await getJ("/api/d/delivery_challan/" + dcId)).doc.segment === "NPD", "NPD tag carried to challan and invoices");
  await p.goto(U + "/#/invoices?segment=NPD"); await p.waitForSelector("h1:has-text(\"Sales Invoices\")");
  ok((await p.textContent("main")).includes("NPD") && !(await p.textContent("main")).includes("R/26-005"), "invoice list filtered to NPD");
}
const led = await getJ("/api/stock/item/1");
ok(led.rows.filter((r) => /Dispatched/.test(r.kind) && ["DC-00001", "R/26-007"].includes(r.ref)).length === 2 && !led.rows.some((r) => r.ref === "R/26-006"), "stock counts challan, not its invoice again");
await p.goto(U + "/#/"); await p.waitForSelector(".kpis"); await p.goto(U + "/#/d/quotation/" + (soId - 1) + "/print"); await p.waitForSelector(".inv-page");
await p.screenshot({ path: join(SHOTS, "quotation_print.png"), fullPage: true });
ok((await p.textContent(".inv-page")).includes("One Thousand One Hundred and Eighty"), "quotation prints with amount in words");

await p.goto(U + "/#/d/purchase_order/new"); await p.waitForSelector("text=New Purchase Order"); await p.waitForSelector("#party_id");
await p.selectOption("#party_id", "1");
await p.selectOption("#lines tr:first-child [name=product_id]", "2");
await p.fill("#lines tr:first-child [name=qty]", "500"); await p.fill("#lines tr:first-child [name=rate]", "100");
await p.click("button:has-text('Save Purchase Order')"); await p.waitForSelector("text=PO-00001 saved");
const poId = Number(p.url().split("/").pop());
const rmBefore = Number((await getJ("/api/stock")).rows.find((r) => r.id === 2).balance);
await p.click("text=Make Goods Receipt"); await p.waitForSelector("text=only the quantity still pending");
await p.fill("#lines tr:first-child [name=qty]", "300");
await p.click("button:has-text('Save Goods Receipt')"); await p.waitForSelector("text=GRN-00001 saved");
const grnId = Number(p.url().split("/").pop());
ok(await statusOf("purchase_order", poId) === "Partly Received", "PO partly received after GRN");
ok(Number((await getJ("/api/stock")).rows.find((r) => r.id === 2).balance) === rmBefore + 300, "GRN adds stock");
await p.click("text=Make Vendor Invoice"); await p.waitForSelector("text=only the quantity still pending");
await p.fill("[name=doc_no]", "VB-777"); await p.fill("[name=total_amount]", "35400");
await p.click("button:has-text('Save Vendor Invoice')"); await p.waitForSelector("text=saved");
ok(await statusOf("grn", grnId) === "Billed", "GRN billed after vendor invoice");
ok(Number((await getJ("/api/stock")).rows.find((r) => r.id === 2).balance) === rmBefore + 300, "vendor invoice from GRN does not add stock twice");
// advance paid against the purchase order is used for the vendor bill made from it
{
  await p.goto(U + "/#/d/purchase_order/" + poId); await p.waitForSelector("text=Record advance");
  await p.click("text=Record advance"); await p.waitForSelector("#orderbox select[name=order_id]");
  ok(await p.inputValue("#orderbox select[name=order_id]") === String(poId) && await p.isHidden("#bills"), "advance form opens with the PO picked");
  await p.fill("[name=amount]", "10000"); await p.fill("[name=reference]", "ADV-1");
  await p.screenshot({ path: join(SHOTS, "advance_form.png"), fullPage: true });
  await p.click("button:has-text('Save payment')"); await p.waitForSelector("text=Payment saved");
  const vb = (await getJ("/api/bills/out?party=1")).rows.find((r) => r.ref === "VB-777");
  ok(vb && vb.advance === 10000 && vb.balance === 25400, "advance against PO adjusted in its vendor bill " + JSON.stringify(vb));
  const adv = await getJ("/api/orders/" + poId + "/advance");
  ok(adv.total === 10000 && adv.used === 10000 && adv.left === 0, "PO shows advance used " + JSON.stringify(adv));
  await p.goto(U + "/#/d/purchase_order/" + poId); await p.waitForSelector(".paystat");
  ok((await p.textContent(".paystat")).includes("10,000.00"), "advance strip on the PO");
  await p.screenshot({ path: join(SHOTS, "advance_po.png"), fullPage: true });
}

// e-way bill from an invoice and from a challan
{
  const invs = await getJ("/api/invoices");
  const inv6 = (invs.rows || invs).find((r) => r.inv_no === "R/26-006");
  await p.goto(U + "/#/invoices/" + inv6.id); await p.waitForSelector("text=E-way bill");
  await p.click("a:has-text('E-way bill')"); await p.waitForSelector("text=What goes in the file");
  ok((await p.textContent("#sum")).includes("vehicle number"), "e-way page asks for the vehicle number");
  await p.fill("[name=vehicle_no]", "mh 14 ab 1234"); await p.fill("[name=distance]", "150");
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#dl")]);
  const file = JSON.parse(require("node:fs").readFileSync(await dl.path(), "utf8"));
  const bill = file.billLists[0];
  ok(dl.suggestedFilename() === "EWB_R_26-006.json", "e-way file named after the invoice");
  ok(bill.docType === "INV" && bill.docNo === "R/26-006" && bill.vehicleNo === "MH14AB1234" && bill.transDistance === 150
    && bill.fromGstin === "27BTHPP6918D1ZG" && bill.fromPincode === 412114 && bill.itemList.length === 1 && bill.itemList[0].quantity === 60,
    "e-way file has the invoice, vehicle, distance and items");
  ok(Math.abs(bill.totalValue + bill.cgstValue + bill.sgstValue + bill.igstValue + bill.OthValue - bill.totInvValue) < 0.02, "e-way totals add up");
  await p.screenshot({ path: join(SHOTS, "eway.png"), fullPage: true });
  await p.fill("[name=ewb_no]", "1234 5678 9012"); await p.click("button:has-text('Save number')");
  await p.waitForSelector("text=E-way bill number saved");
  await p.goto(U + "/#/invoices/" + inv6.id + "/print"); await p.waitForSelector(".inv-page");
  ok((await p.textContent(".inv-page")).includes("123456789012") && (await p.textContent(".inv-page")).includes("MH14AB1234"), "e-way bill no and vehicle print on the invoice");
  await p.goto(U + "/#/eway/delivery_challan/" + dcId); await p.waitForSelector("text=What goes in the file");
  await p.selectOption("[name=reason]", "4"); await p.fill("[name=vehicle_no]", "MH12XY9876");
  const [dl2] = await Promise.all([p.waitForEvent("download"), p.click("#dl")]);
  const b2 = JSON.parse(require("node:fs").readFileSync(await dl2.path(), "utf8")).billLists[0];
  ok(b2.docType === "CHL" && b2.subSupplyType === 4 && b2.cgstValue + b2.sgstValue + b2.igstValue === 0, "challan e-way file for job work, no tax");
}

// deleting the latest invoice gives its number back
{
  const rows = (await getJ("/api/invoices")).rows;
  const last = rows.find((r) => r.inv_no === "R/26-007");
  const res = await p.evaluate(async (id) => (await fetch("/api/invoices/" + id, { method: "DELETE", headers: { "x-requested-with": "ray-erp" } })).json(), last.id);
  ok(/next invoice will be R\/26-007/.test(res.message || ""), "deleting the last invoice gives its number back");
  const c = (await getJ("/api/invoice-counter")).rows.find((r) => r.name === "invoice_26");
  ok(Number(c.value) === 6, "invoice counter back to 6");
  await p.goto(U + "/#/invoices/new"); await p.waitForSelector("text=New Sales Invoice");
  await p.waitForFunction(() => document.querySelector("#next_no")?.textContent === "R/26-007");
  ok((await p.textContent("#next_note")).includes("R/26-007"), "new invoice shows the number it will get");
}

// bank statement: upload, suggestions, post, undo
{
  const XLSX = require("xlsx");
  const post = (path, body) => p.evaluate(async ([u, bd]) => (await fetch(u, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ray-erp" }, body: JSON.stringify(bd) })).json(), [path, body]);
  const inv = await post("/api/invoices/save", { inv_date: "2026-11-01", customer_id: 1, lines: [{ description: "Pipe", hsn: "87089900", uom: "NOS", qty: 20, rate: 100 }] });
  const open = (await getJ("/api/bills/in?party=1")).rows.filter((b) => b.balance > 0.5);
  const target = open.find((b) => b.id === inv.id);
  const custName = (await getJ("/api/m/customers/1")).row.name.toUpperCase();
  const rows = [["State Bank of India"], ["Account No", "62209116087"], [], ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
    ["02 Nov 2026", "02 Nov 2026", `BY TRANSFER-NEFT*${custName.slice(0, 22)}-UTR998877`, "UTR998877", "", String(target.balance), "346457.49"],
    ["05 Nov 2026", "05 Nov 2026", "SMS CHRGS FOR QTR", "", "17.70", "", "346439.79"],
    ["06 Nov 2026", "06 Nov 2026", "TO TRANSFER-SALARY NOV", "", "25000.00", "", "321439.79"],
    ["07 Nov 2026", "07 Nov 2026", "BY CLG CHQ 004512 XYZ", "004512", "", "999.00", "322438.79"]];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Statement");
  const f = join(mkdtempSync(join(tmpdir(), "bank-")), "sbi_nov.xlsx"); XLSX.writeFile(wb, f);
  await p.goto(U + "/#/bank"); await p.waitForSelector("#file");
  await p.setInputFiles("#file", f); await p.waitForSelector("text=4 new entries loaded");
  await p.setInputFiles("#file", f); await p.waitForSelector("text=0 new entries loaded");
  ok(true, "bank upload skips entries already loaded");
  const tr = (txt) => p.locator("table.bank tr", { hasText: txt });
  ok(await tr("UTR998877").locator("[name=kind]").inputValue() === "in" && await tr("UTR998877").locator("[name=party]").inputValue() === "1", "bank receipt matched to the customer by name");
  ok((await tr("UTR998877").textContent()).includes("Settles bills exactly"), "bank receipt settles the invoice exactly");
  ok(await tr("FOR QTR").locator("[name=cat]").inputValue() === "Bank charges", "bank charges recognised");
  ok(await tr("TRANSFER-SALARY").locator("[name=cat]").inputValue() === "Salary & wages", "salary recognised");
  ok(!(await tr("004512").locator("[name=tick]").isChecked()), "unknown receipt left for the user");
  await p.screenshot({ path: join(SHOTS, "bank.png"), fullPage: true });
  await p.click("#post"); await p.waitForSelector("text=3 entries posted");
  ok((await getJ("/api/bills/in?party=1")).rows.find((b) => b.id === inv.id).pay_status === "Paid", "posting the bank receipt marks the invoice paid");
  ok((await getJ("/api/expenses")).byCat.some((c) => c.category === "Bank charges"), "bank charges posted as expense");
  await p.goto(U + "/#/bank?status=done"); await p.waitForSelector("text=Posted as");
  await p.locator("tr", { hasText: "UTR998877" }).locator("[data-undo]").click(); await p.waitForSelector("text=back in To match");
  ok((await getJ("/api/bills/in?party=1")).rows.find((b) => b.id === inv.id).pay_status !== "Paid", "undo removes the payment again");
}

// users + roles
await p.goto(U + "/#/users/new"); await p.waitForSelector("[name=username]");
await p.fill("[name=username]", "ravi.store"); await p.fill("[name=full_name]", "Ravi"); await p.selectOption("[name=role]", "Store");
await p.fill("[name=password]", "secret1"); await p.click("button.primary");
await p.waitForSelector("text=User saved");
await p.goto(U + "/#/"); await p.waitForSelector("text=Welcome");
await p.screenshot({ path: join(SHOTS, "dash.png") });
await p.click("#logout"); await p.waitForSelector("[name=username]");
await p.screenshot({ path: join(SHOTS, "login.png") });
await p.fill("[name=username]", "ravi.store"); await p.fill("[name=password]", "secret1"); await p.click("button");
await p.waitForSelector("text=Welcome");
ok(!(await p.isVisible("text=Upload Customer PO")), "store has no upload tile");
await p.goto(U + "/#/users"); await p.waitForSelector("text=Not allowed");
ok(true, "store blocked from users");
await p.goto(U + "/#/invoices"); await p.waitForSelector("text=R/26-005");
ok(!(await p.isVisible("text=New Invoice")), "store sees invoices read-only");
await p.goto(U + "/#/accounts"); await p.waitForSelector("text=Not allowed");
ok(true, "store blocked from accounts");
await p.goto(U + "/#/stock"); await p.waitForSelector("text=Stock entry");
ok(true, "store can make stock entries");
ok(errors.length === 0, "no page errors " + errors.join(" | "));
await b.close();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
