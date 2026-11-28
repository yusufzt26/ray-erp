# Ray Precicomp ERP

A simple, web-based ERP for **Ray Precicomp** (nylon pipe forming, pipe assemblies and child parts for OEMs and Tier 1s). It runs in any browser, on a PC or phone, and is hosted on **Netlify**.

## What it does

| Area | What you can do |
|---|---|
| **Users & roles** | Admin creates users and gives each one a role: Admin, Purchaser, Sales, Store or Production. On *Role Permissions*, Admin sets what each role can do with each screen: None, View or Edit. |
| **Customers / Vendors** | Master lists with GSTIN, address, contact person, payment terms, supplier code and ship-to address. Codes are automatic (`CUS-0001`, `VEN-0001`). |
| **Products** | One list for everything, with each item marked **Sellable** and/or **Purchasable**. The item code is created from the category, e.g. `FG-00001`. Categories: FG finished good, SA sub-assembly, CP child part, RM raw material, BO bought-out, CN consumable, PK packing. |
| **Excel / CSV import & export** | Every list has *Download template → fill it in → Import*, which accepts .xlsx, .xls or .csv. Leave *Code* empty to add a new record, or fill it to update an existing one. Lists can also be exported to Excel or CSV. |
| **Customer PO / Vendor Invoice PDF upload** | Upload the PDF. The app reads the PO/invoice number, date, party (matched by GSTIN or name), GSTIN, item lines and total. The PDF is shown next to the form so you can correct anything before saving. A tick adds unknown parties or items to the masters with new codes. |
| **Sales Invoice** | Open a Customer PO and press **Make Invoice**. Items come from the PO. GST is worked out automatically: CGST + SGST within Maharashtra, IGST for other states. The amount is written in words in Lakh/Crore. Prints in the Ray Precicomp format with the logo, as Original / Duplicate / Triplicate copies, plus box labels. Numbering continues the `R/26-005` series. |
| **Stock** | Live stock of every item. It goes up with vendor invoices and down with sales invoices automatically. Store / Production make simple entries: opening stock, production done (can also use up raw material), issue to shop floor, and corrections. Each item has a history with running balance. |
| **Production** | One page for everything. The planner makes a **weekly or monthly plan** (product, planned qty, target date, optional sales order) and releases it. Anyone with Production edit logs what was made from the single **Log production** bar (date, shift, operator, product, qty, remarks); partial entries add up and count toward the plan row automatically, and stock goes up with material per piece taken out. The board shows Planned, Done, Balance, progress and Not started / In progress / Done / Late. Every entry of the week or month is listed underneath, with filters, Excel and (Admin) edit / delete; Admin can also edit or delete plans, and stock is corrected to match. The **Production master** holds each item's cycle time (seconds per piece) and material per piece; from them the plan shows the working hours needed (full plan and still to run) and RM / BOP needed against stock, with shortages flagged. A **Production** dashboard (Admin and Production / Store users) shows today, week and month output, plan vs done, late rows and charts. |
| **Sales Register** | Invoices for any date range, by month, by customer or one by one, with taxable value, CGST / SGST / IGST and total. Download to Excel or CSV. |
| **Accounts** | Money to collect from customers and money to pay to vendors. Enter payments received and made; each customer and vendor has a statement with running balance. |
| **Bank** | Add each bank account (name, number, IFSC, opening balance). Upload the bank's Excel / CSV statement for an account; the app suggests the customer or vendor and bills each entry settles, a transfer between your own accounts, or the expense type, and you press Post. Each account shows its balance and checks it against the bank's own balance column, with a statement view (running balance, ✓ / ≠ per entry) and Excel export. Payments entered by hand but not yet seen in the bank are listed. Cash expenses can be typed in on *Expenses & other income*. |
| **Notifications** | WhatsApp-style alerts. A 🔔 bell at the top shows the unread count and the latest events: new sales orders, quotations, challans, sales invoices, purchase orders, GRNs, vendor invoices, payments received / made and production logged. Each person gets alerts only for screens their role can see, never for their own actions, and can mute kinds under ⚙ Settings. While the ERP is open a pop-up card appears with a chime; press **Turn on** once on each phone / PC to also get system notifications with sound, vibration and an app-icon badge even when the ERP is closed (web push; on iPhone, Add to Home Screen first). |

## How it is built

- `public/` is the browser app: plain HTML, CSS and JavaScript, with no framework.
  - `js/app.js` contains the screens, `js/invoice.js` the sales invoice and printing, `js/more.js` stock, sales register and accounts, `js/plan.js` the production plan, `js/pdfread.js` the PDF reading (pdf.js) and `js/fields.js` the field lists shared with the server.
- `netlify/functions/api.mts` is the server API (Netlify Functions, `/api/*`).
- `netlify/database/migrations/` holds the database tables (Netlify Database / Postgres). They are applied automatically on deploy.
- Uploaded PDFs are stored in Netlify Blobs.
- Logins use the app's own users table, with bcrypt passwords and a signed, HTTP-only session cookie.

## First login

**admin / admin123**. The app warns until you change it. Then open **Company Settings** to check the details that print on invoices and the invoice number series.

## Deploy

Connect this repo to a Netlify site (*Add new project → Import from GitHub*). The build settings come from `netlify.toml` (`npm run build`, publish `public`). Netlify Database is provisioned automatically from the migrations on the first deploy.

## Run locally (for developers)

```
npm install
npm run build              # copies pdf.js and SheetJS into public/vendor
node scripts/dev-server.mjs   # http://localhost:8888, throwaway database
node tests/e2e.mjs            # browser test of the main flows (needs Playwright)
```
