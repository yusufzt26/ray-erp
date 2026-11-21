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

// production plan: make this week's plan, release it, log finished qty (adds to stock via material per piece), undo
await p.goto(U + "/#/production"); await p.waitForSelector("text=No plan for this week yet");
await p.click("#make"); await p.waitForSelector("text=Save plan");
await p.selectOption("#rows tr:first-child [name=product_id]", "1"); await p.fill("#rows tr:first-child [name=planned_qty]", "200");
await p.click("#add"); await p.selectOption("#rows tr:nth-child(2) [name=product_id]", "3"); await p.fill("#rows tr:nth-child(2) [name=planned_qty]", "50");
await p.fill("#rows tr:nth-child(2) [name=target_date]", "2020-01-06");
await p.fill("#rows tr:first-child [name=notes]", "For Monday dispatch"); await p.fill("[name=plan_notes]", "Fuel line first, connectors after.");
await p.screenshot({ path: join(SHOTS, "plan_edit.png"), fullPage: true });
await p.click("button:has-text('Save plan')"); await p.waitForSelector("text=Release plan");
ok(await p.isVisible(".pill:has-text('Draft')") && !(await p.isVisible("button.plus")), "plan saved as draft, no Done buttons yet");
await p.click("#release"); await p.waitForSelector("text=Plan released");
const fgP = Number((await stockOf(1)).balance), rmP = Number((await stockOf(2)).balance);
await p.click("tr[data-line] >> nth=0 >> button.plus");
await p.fill("tr.logrow:not([hidden]) [name=qty]", "60"); await p.click("tr.logrow:not([hidden]) button:has-text('Save')");
await p.waitForSelector("text=Finished quantity saved");
await p.click("tr[data-line] >> nth=0 >> button.plus");
await p.fill("tr.logrow:not([hidden]) [name=qty]", "40"); await p.click("tr.logrow:not([hidden]) button:has-text('Save')");
await p.waitForSelector("tr[data-line] >> nth=0 >> text=50%");
ok(Number((await stockOf(1)).balance) === fgP + 100, "logging done adds finished goods to stock");
ok(Math.abs(Number((await stockOf(2)).balance) - (rmP - 45)) < 1e-6, "logging done uses up raw material per piece");
const row1 = await p.textContent("tr[data-line] >> nth=0");
ok(row1.includes("In progress") && row1.includes("50%"), "row shows 100 of 200 in progress");
ok((await p.textContent("tr[data-line] >> nth=1")).includes("Late"), "row past its target date shows Late");
ok((await p.textContent(".overall")).includes("40% done"), "overall progress 100 of 250 = 40%");
await p.screenshot({ path: join(SHOTS, "plan_board.png"), fullPage: true });
await p.click("tr[data-line] >> nth=0 >> a.donecount");
await p.screenshot({ path: join(SHOTS, "plan_logs.png"), fullPage: true });
await p.click("tr.logrow:not([hidden]) button.undo >> nth=0"); await p.click("tr.logrow:not([hidden]) button.undo >> nth=0");
await p.waitForSelector("text=Entry undone"); await p.waitForSelector("tr[data-line] >> nth=0 >> text=20%");
ok(Number((await stockOf(1)).balance) === fgP + 40, "undo removes its stock entry");
await p.goto(U + "/#/?view=admin"); await p.waitForSelector("text=Production this week");
ok((await p.textContent(".kpis")).includes("16% done"), "dashboard card shows production this week");
await p.screenshot({ path: join(SHOTS, "plan_dash.png") });

// daily production entry: partial entries for any date, counted toward the plan row, traced in the log
await p.goto(U + "/#/production/daily"); await p.waitForSelector("text=Daily production entry");
await p.selectOption("[name=shift]", "A"); await p.fill("[name=operator]", "Ramesh");
await p.selectOption("#rows tr:nth-child(1) [name=product_id]", "1"); await p.fill("#rows tr:nth-child(1) [name=qty]", "30");
ok((await p.inputValue("#rows tr:nth-child(1) [name=line_id]")) !== "", "daily entry picks the open plan row");
await p.fill("#rows tr:nth-child(1) [name=remarks]", "first lot");
await p.selectOption("#rows tr:nth-child(2) [name=product_id]", "1"); await p.fill("#rows tr:nth-child(2) [name=qty]", "20");
await p.screenshot({ path: join(SHOTS, "daily_entry.png"), fullPage: true });
const fgD = Number((await stockOf(1)).balance);
await p.click("button:has-text('Save entries')"); await p.waitForSelector("text=2 entries saved");
ok(Number((await stockOf(1)).balance) === fgD + 50, "daily entries add to stock");
ok(await p.inputValue("[name=operator]") === "Ramesh" && await p.inputValue("[name=shift]") === "A", "shift and operator kept for the next entry");
ok((await p.textContent("main")).includes("first lot"), "today's entries listed under the form");
await p.goto(U + "/#/production"); await p.waitForSelector(".overall");
ok((await p.textContent("tr[data-line] >> nth=0")).includes("45%"), "daily entries count toward the plan row (40 + 50 of 200)");
await p.goto(U + "/#/production/log"); await p.waitForSelector("text=All entries");
const logTxt = await p.textContent("main");
ok(logTxt.includes("Ramesh") && logTxt.includes("Week 16/11/2026") && logTxt.includes("first lot"), "log shows operator, plan and remarks");
ok((await p.$$("table.tracelog tr")).length === 4, "log has every partial entry separately (3)");
await p.screenshot({ path: join(SHOTS, "production_log.png"), fullPage: true });
await p.goto(U + "/#/production/log?product=1"); await p.waitForSelector("h1 >> text=FG-00001");
ok((await p.textContent("h1")).includes("FG-00001"), "trace one product");

// Admin edits a production entry (stock follows) and deletes a plan with its entries (stock reversed)
const fgE = Number((await stockOf(1)).balance);
await p.click("button.editlog >> nth=0"); await p.waitForSelector("tr.editrow");
await p.fill("tr.editrow [name=qty]", "25"); await p.fill("tr.editrow [name=remarks]", "recounted");
await p.click("tr.editrow button:has-text('Save')"); await p.waitForSelector("text=Entry updated");
await p.waitForSelector("text=recounted");
ok(Number((await stockOf(1)).balance) === fgE + 5, "admin edits an entry: 20 → 25 and stock follows");
await p.goto(U + "/#/production"); await p.waitForSelector("text=All plans");
await p.click("button.delplan"); await p.waitForSelector("text=Delete plan and its entries? Click again");
await p.click("button.delplan"); await p.waitForSelector("text=Plan deleted, with its 3 production entries");
ok(Number((await stockOf(1)).balance) === fgE + 5 - 95, "deleting the plan reverses its stock entries");
ok(await p.isVisible("text=No plan for this week yet"), "plan gone");
await p.goto(U + "/#/production?period=month"); await p.waitForSelector("text=No plan for this month yet");
ok(true, "month view");

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
ok(!(await p.isVisible("#lines tr:first-child [name=product_id]")) && !(await p.isVisible("text=New product?")), "quotation needs no item code");
const prodCount = (await getJ("/api/m/products?show=all")).rows.length;
await p.fill("#lines tr:first-child [name=party_part_no]", "SAC-FL-0812"); await p.fill("#lines tr:first-child [name=description]", "Nylon fuel line 8x10 (new design)");
await p.fill("#lines tr:first-child [name=qty]", "100"); await p.fill("#lines tr:first-child [name=rate]", "10");
await p.fill("[name=total_amount]", "1180");
await p.selectOption("[name=segment]", "NPD");
await p.fill("[name=delivery_days]", "10"); await p.fill("[name=notes]", "Fixture extra");
ok((await p.inputValue("[name=terms]")).includes("valid for 30 days"), "quotation form shows the default terms to edit");
await p.fill("[name=terms]", (await p.inputValue("[name=terms]")).replace("valid for 30 days", "valid for 15 days"));
await p.click("button:has-text('Save Quotation')");
await p.waitForSelector("text=QTN-00001 saved");
ok((await getJ("/api/m/products?show=all")).rows.length === prodCount, "quotation saved with automatic number, no item created");
await p.click("text=Make Sales Order"); await p.waitForSelector("text=only the quantity still pending");
ok(await p.inputValue("#lines tr:first-child [name=product_id]") === "1", "sales order from quotation finds the item by part no");
const in10 = new Date(Date.now() + 5.5 * 3600e3 + 10 * 864e5).toISOString().slice(0, 10);
ok(await p.inputValue("[name=delivery_date]") === in10, "quotation's 10 days becomes the sales order delivery date");
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
ok((await p.textContent(".inv-page")).includes("Delivery in : 10 days"), "quotation prints delivery in days");
ok((await p.textContent(".inv-page")).includes("valid for 15 days") && !(await p.textContent(".inv-page")).includes("A/c. Payee Cheque"), "quotation prints its own terms");
ok((await p.evaluate(() => document.title)) .startsWith("QTN-00001 - "), "PDF file name is the quotation no and customer");
await p.goto(U + "/#/d/quotation"); await p.waitForSelector("text=🖨 PDF");
await p.click("text=🖨 PDF"); await p.waitForSelector(".inv-page");
ok(p.url().endsWith("/print"), "quotation list opens the PDF print in one click");
ok((await p.textContent("tr.notes")).includes("Notes :"), "quotation prints its notes");

await p.goto(U + "/#/d/purchase_order/new"); await p.waitForSelector("text=New Purchase Order"); await p.waitForSelector("#party_id");
ok((await p.textContent("h1")).includes("PO-00001") && (await p.getAttribute("[name=doc_no]", "placeholder")) === "PO-00001", "new PO shows the number it will get");
await p.selectOption("#party_id", "1");
await p.selectOption("#lines tr:first-child [name=product_id]", "2");
await p.fill("#lines tr:first-child [name=qty]", "500"); await p.fill("#lines tr:first-child [name=rate]", "100");
await p.fill("[name=delivery_days]", "20");
ok((await p.textContent("#dd_by")).startsWith("By "), "PO shows the date the days come to");
ok((await p.inputValue("[name=terms]")).includes("test certificate"), "PO form shows the default PO terms to edit");
await p.fill("[name=terms]", "1. Supply with PPAP documents."); await p.fill("[name=notes]", "Urgent for Welspun");
await p.click("button:has-text('Save Purchase Order')"); await p.waitForSelector("text=PO-00001 saved");
ok(await p.inputValue("[name=delivery_days]") === "20" && (await p.textContent("#dd_by")).startsWith("By "), "PO keeps its delivery days");
{
  const poUrl = p.url();
  await p.goto(poUrl + "/print"); await p.waitForSelector(".inv-page");
  const t = await p.textContent(".inv-page");
  ok(t.includes("Supply with PPAP documents") && t.includes("Urgent for Welspun") && t.includes("Delivery in : 20 days"), "PO prints its own terms, notes and delivery days");
  ok((await p.title()).startsWith("PO-00001 - "), "PO PDF file name is the PO no and vendor");
  await p.goto(poUrl);
  await p.waitForSelector("text=Purchase Order");
}
const poId = Number(p.url().split("/").pop());
const rmBefore = Number((await getJ("/api/stock")).rows.find((r) => r.id === 2).balance);
await p.click("text=Make Goods Receipt"); await p.waitForSelector("text=only the quantity still pending");
await p.fill("#lines tr:first-child [name=qty]", "300");
await p.click("button:has-text('Save Goods Receipt')"); await p.waitForSelector("text=GRN-00001 saved");
const grnId = Number(p.url().split("/").pop());
ok(await statusOf("purchase_order", poId) === "Partly Received", "PO partly received after GRN");
{ const r = (await getJ("/api/d/purchase_order")).rows.find((x) => x.id === poId); ok(r.pending_qty > 0, "PO list carries pending qty " + r.pending_qty + " " + r.pending_uom);
  const back = p.url(); await p.waitForTimeout(1000); await p.goto(U + "/#/d/purchase_order"); await p.waitForSelector("table.grid >> text=Partly Received"); await p.waitForTimeout(500);
  ok((await p.textContent("main")).includes("Pending " + Number(r.pending_qty).toLocaleString("en-IN")), "PO list shows Pending qty next to Partly Received");
  await p.screenshot({ path: join(SHOTS, "list_pending.png") }); await p.goto(back); await p.waitForSelector("text=Make Vendor Invoice"); await p.waitForTimeout(800); }
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

// new category from the product form
await p.goto(U + "/#/"); await p.goto(U + "/#/m/products/new"); await p.waitForSelector("[name=name]");
await p.selectOption("[name=category]", "__new"); await p.waitForSelector("#nc_name");
await p.fill("#nc_name", "Tooling & Fixtures");
ok(await p.inputValue("#nc_code") === "TF", "category code suggested from the name");
await p.screenshot({ path: join(SHOTS, "new_category.png") });
await p.click("#nc_add"); await p.waitForSelector("text=Category TF - Tooling & Fixtures added");
ok(await p.inputValue("[name=category]") === "TF", "new category selected");
await p.waitForFunction(() => document.querySelector("#next_code")?.textContent === "TF-00001");
ok(true, "new product shows the code it will get");
await p.fill("[name=name]", "Crimping Fixture 8mm"); await p.click("button[name=save]");
await p.waitForSelector("text=TF-00001 created");
ok(true, "product in new category numbered TF-00001");
await p.goto(U + "/#/m/products/new"); await p.waitForSelector("[name=name]");
ok(await p.locator("[name=category] option[value=TF]").count() === 1, "new category kept in the list");

// type-ahead on quotation lines
await p.goto(U + "/#/"); await p.goto(U + "/#/d/quotation/new"); await p.waitForSelector("text=New Quotation"); await p.waitForSelector("#party_id");
await p.waitForTimeout(1500); // let the dashboard request started by "#/" finish, so the form is not redrawn while typing
await p.click("#lines tr:first-child [name=description]"); await p.keyboard.type("nfl");
await p.waitForSelector(".suggest:not([hidden]) .sg");
ok((await p.textContent(".suggest")).includes("Nylon Fuel Line Assy"), "short form 'nfl' suggests Nylon Fuel Line Assy");
await p.screenshot({ path: join(SHOTS, "qtn_suggest.png") });
await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter");
await p.waitForFunction(() => document.querySelector("#lines tr:first-child [name=party_part_no]").value !== "", null, { timeout: 5000 }).catch(() => {});
ok(await p.inputValue("#lines tr:first-child [name=party_part_no]") === "SAC-FL-0812", "picking a suggestion fills part no");
await p.fill("#lines tr:first-child [name=party_part_no]", ""); await p.fill("#lines tr:first-child [name=description]", "");
await p.click("#lines tr:first-child [name=description]"); await p.keyboard.type("new des");
await p.waitForSelector(".suggest:not([hidden]) .sg");
ok((await p.textContent(".suggest")).includes("used before"), "lines from earlier quotations are suggested");
await p.click("#lines tr:first-child [name=party_part_no]"); await p.keyboard.type("sac");
await p.waitForSelector(".suggest:not([hidden]) .sg");
ok((await p.textContent(".suggest")).includes("SAC-FL-0812"), "part no suggestions from first letters");

// quotation numbers: a deleted number can be typed and reused; used or skipped numbers are refused
{
  const call = (method, path, body) => p.evaluate(async ([m, u, bd]) => { const r = await fetch(u, { method: m, headers: { "content-type": "application/json", "x-requested-with": "ray-erp" }, body: bd ? JSON.stringify(bd) : undefined }); return { status: r.status, ...(await r.json()) }; }, [method, path, body]);
  const qtn = (doc_no) => call("POST", "/api/d/quotation/save", { party_name: "Number Test Co", doc_no, lines: [{ description: "Test part", qty: 1, rate: 10, amount: 10 }] });
  const a = await qtn(""), b2 = await qtn("");
  await call("DELETE", "/api/d/quotation/" + a.id);
  const opts = await getJ("/api/d/quotation/options");
  ok(opts.free_refs.includes(a.ref_no), "deleted quotation number offered as free");
  const reused = await qtn(a.ref_no.replace("QTN-0000", ""));
  ok(reused.ref_no === a.ref_no, "typed free number is used as the quotation number");
  ok((await qtn(b2.ref_no)).status === 400, "number already used is refused");
  ok((await qtn("QTN-09999")).status === 400, "skipping ahead is refused");
  // an existing quotation changed to a deleted number keeps its lines and gets that number
  const c3 = await qtn(""); await call("DELETE", "/api/d/quotation/" + b2.id);
  const moved = await call("POST", "/api/d/quotation/save", { id: c3.id, party_name: "Number Test Co", doc_no: b2.ref_no, delivery_days: "15", segment: "NPD", lines: [{ description: "Test part", qty: 1, rate: 10, amount: 10 }] });
  ok(moved.status === 200 && moved.ref_no === b2.ref_no, "saved quotation renumbered to a deleted number " + JSON.stringify(moved));
  // the same for purchase orders
  const po = (doc_no, id) => call("POST", "/api/d/purchase_order/save", { id, party_name: "Number Test Vendor", doc_no, delivery_days: "7", lines: [{ description: "Test RM", qty: 1, rate: 10, amount: 10 }] });
  const pa = await po(""), pb = await po("");
  await call("DELETE", "/api/d/purchase_order/" + pa.id);
  ok((await getJ("/api/d/purchase_order/options")).free_refs.includes(pa.ref_no), "deleted PO number offered as free");
  const pm = await po(pa.ref_no, pb.id);
  ok(pm.status === 200 && pm.ref_no === pa.ref_no, "saved PO renumbered to a deleted number " + JSON.stringify(pm));
  ok((await po(pa.ref_no)).status === 400, "PO number already used is refused");
  const ex = await call("POST", "/api/d/purchase_order/save", { party_name: "Office Supplier", segment: "Expense", lines: [{ description: "Office chairs", qty: 2, rate: 3000, amount: 6000 }] });
  const exRows = (await getJ("/api/d/purchase_order?segment=Expense")).rows;
  ok(exRows.some((r) => r.id === ex.id && r.segment === "Expense") && !(await getJ("/api/d/purchase_order?segment=Regular")).rows.some((r) => r.id === ex.id), "Expense type saved and filtered");
  // date filter: an old PO shows under "All dates" only; today's PO under every period
  const old = await call("POST", "/api/d/purchase_order/save", { party_name: "Old Vendor", doc_date: "2024-01-10", lines: [{ description: "Old RM", qty: 1, rate: 5, amount: 5 }] });
  const ids = async (per) => (await getJ("/api/d/purchase_order?period=" + per)).rows.map((r) => r.id);
  const [all, today, week, month, year] = await Promise.all(["", "today", "week", "month", "year"].map(ids));
  ok(all.includes(old.id) && [today, week, month, year].every((l) => !l.includes(old.id) && l.includes(ex.id)), "PO date filter: today / week / month / year / all");
  ok((await getJ("/api/invoices?period=today")).rows.length <= (await getJ("/api/invoices")).rows.length, "invoice list takes the date filter");
  await p.goto(U + "/#/d/customer_po?period=month"); await p.waitForSelector("select[name=period]");
  ok(await p.inputValue("select[name=period]") === "month", "sales order list shows the date filter");
  const rng = async (qs) => (await getJ("/api/d/purchase_order?" + qs)).rows.map((r) => r.id);
  const lastM = await rng("period=lastmonth");
  ok(!lastM.includes(ex.id) && !lastM.includes(old.id), "last month leaves out this month and old POs");
  ok((await rng("period=custom&from=2024-01-01&to=2024-01-31")).includes(old.id) && !(await rng("period=custom&from=2024-01-01&to=2024-01-31")).includes(ex.id), "custom from/to finds the January 2024 PO only");
  await p.goto(U + "/#/d/purchase_order"); await p.waitForSelector("select[name=period]"); await p.waitForTimeout(500);
  await p.selectOption("select[name=period]", "custom");
  ok(await p.isVisible("input[name=from]") && await p.isVisible("input[name=to]"), "custom shows From and To dates");
  await p.fill("input[name=from]", "2024-01-01"); await p.fill("input[name=to]", "2024-01-31"); await p.dispatchEvent("input[name=to]", "change");
  await p.waitForFunction(() => location.hash.includes("from=2024-01-01") && !document.querySelector("main").textContent.includes("Office Supplier"), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(500);
  ok(!(await p.textContent("main")).includes("Office Supplier"), "custom range applied on the list");
  await p.screenshot({ path: join(SHOTS, "date_custom.png") });
  await p.goto(U + "/#/d/purchase_order?segment=Expense"); await p.waitForSelector(".pill.exp");
  ok(await p.isVisible("select[name=segment] >> text=Expenses") || (await p.inputValue("select[name=segment]")) === "Expense", "Expenses offered in the type filter");
}

// services: bought and sold like items, never in stock
{
  const res = await p.evaluate(async () => (await fetch("/api/m/products", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ray-erp" },
    body: JSON.stringify({ name: "Tube cutting job work", category: "SV", uom: "JOB", hsn: "998898", gst_rate: 18, sellable: true, purchasable: true, active: true }) })).json());
  ok(/^SV-0000\d$/.test(res.code || ""), "service item gets an SV code " + JSON.stringify(res));
  ok(!(await getJ("/api/stock")).rows.some((r) => r.code === res.code), "service is not listed in stock");
  ok((await getJ("/api/d/purchase_order/options")).products.some((x) => x.code === res.code), "service can be picked on a PO");
  ok((await getJ("/api/d/quotation/options")).products.some((x) => x.code === res.code), "service can be picked on a quotation");
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
await p.waitForTimeout(1500); // let any slower page from before the login finish and redraw
ok(!(await p.isVisible("text=Upload Customer PO")), "store has no upload tile");
await p.goto(U + "/#/users"); await p.waitForSelector("text=Not allowed");
ok(true, "store blocked from users");
await p.goto(U + "/#/invoices"); await p.waitForSelector("text=R/26-005");
ok(!(await p.isVisible("text=New Invoice")), "store sees invoices read-only");
await p.goto(U + "/#/accounts"); await p.waitForSelector("text=Not allowed");
ok(true, "store blocked from accounts");
await p.goto(U + "/#/stock"); await p.waitForSelector("text=Stock entry");
ok(true, "store can make stock entries");

// accounts user: payments, bank and invoices; orders read-only; no user admin
await p.click("#logout"); await p.waitForSelector("[name=username]");
await p.fill("[name=username]", "admin"); await p.fill("[name=password]", "admin123"); await p.click("button"); await p.waitForSelector("text=Welcome");
// GST worked out automatically: CGST + SGST in our state, IGST for another state, per-line rate, typed amounts kept
{
  await p.goto(U + "/#/d/purchase_order/new"); await p.waitForSelector("#party_id"); await p.waitForTimeout(500);
  await p.selectOption("#party_id", { index: 1 });
  await p.fill("#party_gstin", "27AAACP1234F1Z5"); await p.dispatchEvent("#party_gstin", "input");
  await p.fill("#lines tr:first-child [name=description]", "Tube FLX 9X7/PA12 Black"); await p.keyboard.press("Escape");
  await p.fill("#lines tr:first-child [name=qty]", "10000"); await p.fill("#lines tr:first-child [name=rate]", "36.4");
  await p.dispatchEvent("#lines tr:first-child [name=rate]", "change");
  await p.fill("#lines tr:first-child [name=gst_rate]", "18"); await p.dispatchEvent("#lines tr:first-child [name=gst_rate]", "input");
  ok(await p.inputValue("#cgst") === "32760.00" && await p.inputValue("#sgst") === "32760.00" && await p.isHidden("#igst"), "same state: CGST + SGST 9% each worked out");
  ok(await p.inputValue("#total_amount") === "429520.00", "PO total = taxable + GST, no typing needed");
  await p.fill("#party_gstin", "24AAACP1234F1Z5"); await p.dispatchEvent("#party_gstin", "input");
  ok(await p.inputValue("#igst") === "65520.00" && await p.isHidden("#cgst"), "other state GSTIN switches to IGST 18%");
  ok((await p.textContent("#gst_why")).includes("Gujarat"), "shows why: other state named");
  await p.click("#addline");
  await p.fill("#lines tr:nth-child(2) [name=description]", "Testing charges"); await p.keyboard.press("Escape");
  await p.fill("#lines tr:nth-child(2) [name=amount]", "1000"); await p.dispatchEvent("#lines tr:nth-child(2) [name=amount]", "input");
  await p.fill("#lines tr:nth-child(2) [name=gst_rate]", "12"); await p.dispatchEvent("#lines tr:nth-child(2) [name=gst_rate]", "input");
  ok(await p.inputValue("#igst") === "65640.00" && await p.inputValue("#total_amount") === "430640.00", "each line taxed at its own GST %");
  await p.fill("#igst", "65640.40"); await p.dispatchEvent("#igst", "input");
  ok(await p.inputValue("#total_amount") === "430640.40" && await p.isVisible("#regst"), "typed IGST kept and total follows");
  await p.click("button:has-text('Save Purchase Order')"); await p.waitForSelector("text=saved");
  const gid = Number(p.url().split("/").pop());
  const saved = (await getJ("/api/d/purchase_order/" + gid)).doc;
  ok(saved.tax_type === "IGST" && Number(saved.igst) === 65640.4 && Number(saved.total_amount) === 430640.4 && Number(saved.cgst) === 0, "PO saved with IGST split");
  await p.waitForTimeout(800);
  ok(await p.inputValue("#igst") === "65640.40" && await p.isVisible("#regst"), "reopened PO keeps the typed IGST");
  await p.goto(U + `/#/d/purchase_order/${gid}/print`); await p.waitForSelector(".print-area");
  const pt = await p.textContent(".print-area");
  ok(pt.includes("IGST") && pt.includes("65,640.40") && pt.includes("Taxable value"), "PO print shows taxable value and IGST");
  await p.screenshot({ path: join(SHOTS, "po_gst_print.png"), fullPage: true });
  // sales invoice: line GST % from the item, CGST + SGST for our state
  await p.goto(U + "/#/invoices/new"); await p.waitForSelector("#customer_id"); await p.waitForTimeout(500);
  await p.selectOption("#customer_id", { index: 1 });
  await p.fill("[name=gstin]", "27AABCA1234B1Z5"); await p.dispatchEvent("[name=gstin]", "input");
  await p.fill("#lines tr:first-child [name=description]", "Fuel line"); await p.fill("#lines tr:first-child [name=qty]", "10");
  await p.fill("#lines tr:first-child [name=rate]", "100"); await p.fill("#lines tr:first-child [name=gst_rate]", "28");
  await p.dispatchEvent("#lines tr:first-child [name=gst_rate]", "input");
  const sum = await p.textContent("#sum");
  ok(sum.includes("CGST") && sum.includes("14%") && sum.includes("140.00") && sum.includes("1,280.00"), "invoice uses the line's GST %: CGST 14% + SGST 14%");
  await p.screenshot({ path: join(SHOTS, "invoice_gst.png"), fullPage: true });
  await p.goto(U + "/#/d/purchase_order/" + gid); await p.waitForSelector("#igst");
  await p.screenshot({ path: join(SHOTS, "po_gst.png"), fullPage: true });
}
// Excel downloads come from the server (works in the installed phone app); invoice list has Excel too
{
  const XL = (await import("xlsx")).default;
  await p.waitForTimeout(800); await p.goto(U + "/#/invoices"); await p.waitForSelector("#exx"); await p.waitForTimeout(500);
  const [d1] = await Promise.all([p.waitForEvent("download"), p.click("#exx")]);
  ok(d1.suggestedFilename() === "Sales invoices.xlsx" && /\/api\/download\/dl-/.test(d1.url()), "invoice list Excel from the server " + d1.url());
  const wb1 = XL.readFile(await d1.path());
  const inv1 = XL.utils.sheet_to_json(wb1.Sheets.Invoices, { header: 1 });
  ok(inv1[0][4] === "Customer PO No" && inv1.slice(1).some((r) => String(r[4] || "").trim()), "invoice Excel has Customer PO No");
  ok(inv1[0][2] === "Customer" && inv1.slice(1).every((r) => String(r[2] || "").trim()), "invoice Excel: customer filled on every row " + JSON.stringify(inv1[1]));
  ok(wb1.SheetNames.join() === "Invoices,Items" && inv1[0][0] === "Invoice No" && inv1.length > 1 && XL.utils.sheet_to_json(wb1.Sheets.Items).length > 0, "invoice Excel has invoices and items " + inv1.length);
  const [d2] = await Promise.all([p.waitForEvent("download"), p.click("#exc")]);
  ok(d2.suggestedFilename() === "Sales invoices.csv", "invoice list CSV");
  await p.goto(U + "/#/d/purchase_order"); await p.waitForSelector("#exx"); await p.waitForTimeout(500);
  const [d3] = await Promise.all([p.waitForEvent("download"), p.click("#exx")]);
  const po1 = XL.utils.sheet_to_json(XL.readFile(await d3.path()).Sheets.Lines, { header: 1 });
  ok(po1[0][0] === "Ref No" && po1.length > 1, "PO list Excel opens with lines " + po1.length);
}
// lists sort by a clicked column heading; new customer gets State and PAN from the GSTIN
{
  await p.waitForTimeout(800); await p.goto(U + "/#/d/purchase_order?period="); await p.waitForSelector("table.grid tr[data-href]"); await p.waitForTimeout(800);
  const refs = async () => p.$$eval("table.grid tr[data-href] td:first-child", (tds) => tds.map((t) => t.textContent.trim()));
  await p.click("table.grid th:first-child");
  const asc = await refs();
  ok(asc.length > 1 && asc.every((r, i) => i === 0 || asc[i - 1] <= r), "click heading sorts ascending " + asc.join(","));
  await p.click("table.grid th:first-child");
  const desc = await refs();
  ok(desc.join() === [...asc].reverse().join(), "click again sorts descending");
  await p.screenshot({ path: join(SHOTS, "list_sorted.png") });
  await p.goto(U + "/#/m/vendors/new"); await p.waitForSelector("[name=gstin]");
  await p.fill("[name=gstin]", "24AAACP5678K1Z2");
  ok(await p.inputValue("[name=state]") === "Gujarat" && await p.inputValue("[name=pan]") === "AAACP5678K", "new vendor: State and PAN filled from GSTIN");
  await p.screenshot({ path: join(SHOTS, "vendor_gstin_fill.png") });
  await p.waitForSelector("#gstin_note a"); ok((await p.textContent("#gstin_note")).includes("GST portal"), "unknown GSTIN offers the GST portal look-up");
  await p.goto(U + "/#/m/customers/new"); await p.waitForSelector("[name=gstin]");
  await p.fill("[name=gstin]", "27AAFFP5555Q1ZK");
  await p.waitForFunction(() => document.querySelector("[name=name]").value);
  ok(await p.inputValue("[name=name]") === "Polytube Extrusions LLP" && await p.inputValue("[name=state]") === "Maharashtra", "new customer: name filled from the vendor with the same GSTIN");
  await p.screenshot({ path: join(SHOTS, "customer_gstin_name.png") });
}
// setup period: link an old GRN to its PO, and an old invoice to its sales order
{
  const post = (u, body) => p.evaluate(async ([u, body]) => (await fetch(u, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ray-erp" }, body: JSON.stringify(body) })).json(), [u, body]);
  const po = (await getJ("/api/d/purchase_order")).rows.find((r) => r.party_name === "Polytube Extrusions LLP");
  const vendorId = (await getJ("/api/d/purchase_order/" + po.id)).doc.party_id;
  const oldGrn = await post("/api/d/grn/save", { party_id: vendorId, doc_date: "2026-10-02", lines: [{ description: "Tube FLX 9X7/PA12 Black", qty: 50, rate: 36.4 }] });
  ok(oldGrn.id, "old GRN entered " + JSON.stringify(oldGrn));
  ok(Array.isArray((await getJ(`/api/accounts/statement/out/${vendorId}`)).rows), "vendor statement opens");
  await p.goto(U + "/#/d/grn/" + oldGrn.id); await p.waitForSelector("#lo_pick");
  ok((await p.textContent("#linkold")).includes("Link to an earlier Purchase Order"), "old GRN offers linking to an earlier PO");
  await p.selectOption("#lo_pick", String(po.id)); await p.click("#lo_save"); await p.waitForSelector("text=Linked to");
  ok((await getJ("/api/d/grn/" + oldGrn.id)).doc.parent_id === po.id, "old GRN now linked to the PO");
  await p.waitForSelector(`#links >> text=${po.ref_no}`);
  ok(true, "linked documents show the PO next to the old GRN");
  await p.screenshot({ path: join(SHOTS, "link_old_grn.png"), fullPage: true });
  await p.goto(U + "/#/d/purchase_order/" + po.id); await p.waitForSelector(`button[data-unlink="doc/${oldGrn.id}"]`);
  await p.screenshot({ path: join(SHOTS, "unlink_chain.png"), fullPage: true });
  await p.click(`button[data-unlink="doc/${oldGrn.id}"]`);
  await p.waitForFunction(async (g) => !(await (await fetch("/api/d/grn/" + g)).json()).doc.parent_id, oldGrn.id, { timeout: 8000 }).catch(() => {});
  ok(!(await getJ("/api/d/grn/" + oldGrn.id)).doc.parent_id, "Unlink from the PO's linked documents removes the GRN link");
  await post("/api/link-old/doc/" + oldGrn.id, { parent_id: po.id });
  const inv = (await getJ("/api/invoices")).rows.find((r) => r.status !== "Cancelled");
  { const so = (await getJ("/api/d/customer_po")).rows.find((r) => r.doc_no);
    const soDoc = (await getJ("/api/d/customer_po/" + so.id)).doc;
    const bad = await post("/api/invoices/save", { customer_id: soDoc.party_id, inv_date: "2026-11-19", customer_po_id: so.id, po_no: "WRONG-99999", lines: [{ description: "x", qty: 1, rate: 1 }] });
    ok(/does not match/.test(bad.error || ""), "invoice refused for a sales order with a different customer PO no " + JSON.stringify(bad));
    const dupSo = await post("/api/d/customer_po/save", { party_id: soDoc.party_id, doc_no: " " + soDoc.doc_no.toLowerCase().replace(/-/g, " ") + " ", lines: [{ description: "x", qty: 1, rate: 1 }] });
    ok(/already entered as sales order/.test(dupSo.error || ""), "same customer PO number refused for the same customer " + JSON.stringify(dupSo));
    const resave = await post("/api/d/customer_po/save", { id: so.id, party_id: soDoc.party_id, doc_no: soDoc.doc_no, status: soDoc.status, lines: (await getJ("/api/d/customer_po/" + so.id)).lines });
    ok(resave.id === so.id, "re-saving the same sales order is fine " + JSON.stringify(resave).slice(0, 120));
    const opts = await getJ(`/api/link-old/invoice/${inv.id}`);
    const invPo = (await getJ("/api/invoices/" + inv.id)).inv.po_no;
    ok(opts.candidates.every((c) => !c.cust_po || !invPo || c.cust_po.replace(/[^A-Z0-9]/gi, "").toUpperCase().startsWith(invPo.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 6))), "link list offers only matching customer PO numbers"); }
  await p.goto(U + "/#/invoices/" + inv.id); await p.waitForSelector("#links");
  await p.waitForTimeout(800);
  if (await p.isVisible("#lo_pick")) {
    const so = await p.$eval("#lo_pick", (s) => [...s.options].find((o) => o.value)?.value);
    await p.selectOption("#lo_pick", so); await p.click("#lo_save"); await p.waitForSelector("text=Linked to");
    const saved = (await getJ("/api/invoices/" + inv.id)).inv;
    ok(String(saved.customer_po_id) === so || String(saved.challan_id) === so, "old invoice linked to the sales order / challan " + so + " " + JSON.stringify([saved.customer_po_id, saved.challan_id]));
  } else ok((await p.textContent("main")).includes("Linked documents"), "invoice shows links panel");
  await p.evaluate(async () => fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json", "x-requested-with": "ray-erp" }, body: JSON.stringify({ link_old_until: "" }) }));
  await p.goto(U + "/#/d/grn/" + oldGrn.id); await p.waitForSelector("#links"); await p.waitForTimeout(800);
  ok(!(await p.isVisible("#lo_pick")), "linking hidden once the setup period is switched off");
  ok(await p.isVisible("#lo_unlink"), "unlink still offered after the setup period"); await p.screenshot({ path: join(SHOTS, "unlink.png") });
  await p.click("#lo_unlink"); await p.waitForSelector("text=Link removed");
  ok(!(await getJ("/api/d/grn/" + oldGrn.id)).doc.parent_id, "GRN unlinked from the PO");
  const refused = await post("/api/link-old/doc/" + oldGrn.id, { parent_id: po.id });
  ok(/switched off/.test(refused.error || refused.message || ""), "server refuses linking after the period " + JSON.stringify(refused));
}
await p.goto(U + "/#/users/new"); await p.waitForSelector("[name=username]");
await p.fill("[name=username]", "priya.accounts"); await p.fill("[name=full_name]", "Priya"); await p.selectOption("[name=role]", "Accounts");
await p.fill("[name=password]", "secret2"); await p.click("button.primary"); await p.waitForSelector("text=User saved");
await p.click("#logout"); await p.waitForSelector("[name=username]");
await p.fill("[name=username]", "priya.accounts"); await p.fill("[name=password]", "secret2"); await p.click("button"); await p.waitForSelector("text=Welcome");
await p.waitForTimeout(1000);
await p.goto(U + "/#/accounts"); await p.waitForSelector("h1"); ok(!(await p.isVisible("text=Not allowed")), "accounts user opens Accounts");
await p.goto(U + "/#/bank"); await p.waitForSelector("h1"); ok(!(await p.isVisible("text=Not allowed")), "accounts user opens Bank");
await p.goto(U + "/#/payments/new"); await p.waitForSelector("h1"); ok(!(await p.isVisible("text=Not allowed")), "accounts user can record a payment");
await p.goto(U + "/#/d/quotation"); await p.waitForSelector("h1"); ok(!(await p.isVisible("text=New Quotation")), "accounts user sees quotations read-only");
await p.goto(U + "/#/users"); await p.waitForSelector("text=Not allowed"); ok(true, "accounts user blocked from users");
ok(errors.length === 0, "no page errors " + errors.join(" | "));
await b.close();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
