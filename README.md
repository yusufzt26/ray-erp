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
| **Sales Register** | Invoices for any date range, by month, by customer or one by one, with taxable value, CGST / SGST / IGST and total. Download to Excel or CSV. |
| **Accounts** | Money to collect from customers and money to pay to vendors. Enter payments received and made; each customer and vendor has a statement with running balance. |

## How it is built

- `public/` is the browser app: plain HTML, CSS and JavaScript, with no framework.
  - `js/app.js` contains the screens, `js/invoice.js` the sales invoice and printing, `js/more.js` stock, sales register and accounts, `js/pdfread.js` the PDF reading (pdf.js) and `js/fields.js` the field lists shared with the server.
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
