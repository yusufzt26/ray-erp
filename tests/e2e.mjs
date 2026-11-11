// Browser test against a running server: node tests/e2e.mjs [baseUrl]
// (start one first with: node scripts/dev-server.mjs)
import { createRequire } from "node:module";
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

// invoice from PO
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
await p.goto(U + "/#/payments/new?dir=in&party=1"); await p.waitForSelector("text=Outstanding now");
await p.fill("[name=amount]", "33517"); await p.fill("[name=reference]", "UTR123");
await p.click("button:has-text('Save payment')");
await p.waitForSelector("text=Payment saved");
ok((await p.textContent("main")).includes("1,00,000.00"), "statement balance after payment");
await p.screenshot({ path: join(SHOTS, "statement.png"), fullPage: true });
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
await p.screenshot({ path: join(SHOTS, "doc_links.png"), fullPage: true });
await p.click("text=Make Invoice"); await p.waitForSelector("text=New Sales Invoice"); await p.waitForSelector("#lines tr");
ok(await p.inputValue("#lines tr:first-child [name=qty]") === "40", "invoice from sales order takes only the balance");
await p.click("button:has-text('Save invoice')"); await p.waitForSelector("text=R/26-007 saved", { timeout: 15000 });
ok(await statusOf("customer_po", soId) === "Completed", "sales order completed");
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
