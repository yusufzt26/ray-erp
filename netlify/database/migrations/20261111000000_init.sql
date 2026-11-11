CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE role_permissions (
  role TEXT NOT NULL,
  module TEXT NOT NULL,
  level TEXT NOT NULL,
  PRIMARY KEY (role, module)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  gstin TEXT, pan TEXT,
  address TEXT, city TEXT, state TEXT, pincode TEXT,
  contact_person TEXT, phone TEXT, email TEXT,
  supplier_code TEXT, ship_to TEXT, delivery_condition TEXT,
  payment_terms TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE vendors (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  gstin TEXT, pan TEXT,
  address TEXT, city TEXT, state TEXT, pincode TEXT,
  contact_person TEXT, phone TEXT, email TEXT,
  payment_terms TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'FG',
  description TEXT,
  uom TEXT DEFAULT 'NOS',
  hsn TEXT,
  gst_rate DOUBLE PRECISION,
  sellable INTEGER NOT NULL DEFAULT 0,
  purchasable INTEGER NOT NULL DEFAULT 0,
  sale_rate DOUBLE PRECISION,
  purchase_rate DOUBLE PRECISION,
  customer_part_no TEXT,
  drawing_no TEXT,
  material TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  doc_type TEXT NOT NULL,
  ref_no TEXT,
  doc_no TEXT,
  doc_date DATE,
  party_id INTEGER,
  party_name TEXT,
  party_gstin TEXT,
  delivery_date DATE,
  subtotal DOUBLE PRECISION,
  tax_amount DOUBLE PRECISION,
  total_amount DOUBLE PRECISION,
  notes TEXT,
  pdf_file TEXT,
  status TEXT DEFAULT 'Open',
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE document_lines (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no INTEGER,
  product_id INTEGER,
  party_part_no TEXT,
  description TEXT,
  hsn TEXT,
  qty DOUBLE PRECISION,
  uom TEXT,
  rate DOUBLE PRECISION,
  amount DOUBLE PRECISION
);

CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  inv_no TEXT UNIQUE NOT NULL,
  inv_date DATE NOT NULL,
  customer_id INTEGER,
  customer_po_id INTEGER,
  po_no TEXT,
  po_date DATE,
  supplier_code TEXT,
  bill_to TEXT,
  ship_to TEXT,
  gstin TEXT,
  pan TEXT,
  tax_type TEXT NOT NULL DEFAULT 'IGST',
  gst_rate DOUBLE PRECISION NOT NULL DEFAULT 18,
  subtotal DOUBLE PRECISION,
  cgst DOUBLE PRECISION,
  sgst DOUBLE PRECISION,
  igst DOUBLE PRECISION,
  total DOUBLE PRECISION,
  delivery_condition TEXT,
  payment_terms TEXT,
  packing TEXT,
  status TEXT DEFAULT 'Issued',
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE invoice_lines (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no INTEGER,
  product_id INTEGER,
  material_code TEXT,
  part_no TEXT,
  description TEXT,
  hsn TEXT,
  uom TEXT,
  qty DOUBLE PRECISION,
  rate DOUBLE PRECISION,
  disc DOUBLE PRECISION,
  amount DOUBLE PRECISION
);

CREATE INDEX idx_documents_type ON documents(doc_type);
CREATE INDEX idx_lines_doc ON document_lines(document_id);

-- First login: admin / admin123 (the app asks to change it)
INSERT INTO users (username, full_name, role, password_hash)
VALUES ('admin', 'Administrator', 'Admin', '$2b$10$pqzeOu7epbfPp1w0Iep.r.0cMRJOMyBDt2uSaTPUIM8BKFCT3BUIK');

INSERT INTO settings (key, value) VALUES
  ('company_name', 'RAY PRECICOMP'),
  ('company_gstin', '27BTHPP6918D1ZG'),
  ('company_pan', 'BTHPP6918D'),
  ('company_state', '27 Maharashtra'),
  ('company_gst_wef', '01/07/2017'),
  ('company_address', 'Gat No. 100, Behind Zunka Hotel, Jyotibanagar, Talawade, Pune 412114'),
  ('company_email', 'sales@rayprecicomp.com'),
  ('company_mobile', '+91 9967023983'),
  ('company_tagline', E'Next-Gen Pipe Assemblies\nIntegrated Fluid, Fuel and Air Routing Systems for Conventional & Electrified Mobility'),
  ('invoice_prefix', 'R'),
  ('invoice_terms', E'Payment to be made by A/c. Payee Cheque Only.\nInterest @18% will be charged on bill not paid within due date.'),
  ('bank_details', E'Account Name : Ray Precicomp\nState Bank of India Ac No : 62209116087\nIFSC : SBIN0020869'),
  ('invoice_declaration', 'I / we certify that our registration certificate under the GST Act, 2017 is in force on the date on which the supply of goods specified in this Tax Invoice is made by me/us & the transaction of supply covered by this Tax Invoice had been effected by me/us & it shall be accounted for in the turnover of supplies while filling of return & the due tax if any payable on the supplies has been paid or shall be paid. Further certified that the particulars given above are true and correct & the amount indicated represents the prices charged and that there is no flow additional consideration directly or indirectly from the buyer. Interest @ 18% p.a. charged on all outstanding more than one month after invoice has been rendered.');

-- Invoice series continues after R/26-004 (FY 2026-27)
INSERT INTO counters (name, value) VALUES ('invoice_26', 4);

INSERT INTO role_permissions (role, module, level) VALUES
  ('Purchaser', 'customers', 'none'), ('Purchaser', 'vendors', 'edit'), ('Purchaser', 'products', 'edit'),
  ('Purchaser', 'sales_invoice', 'none'), ('Sales', 'sales_invoice', 'edit'), ('Store', 'sales_invoice', 'view'), ('Production', 'sales_invoice', 'none'),
  ('Purchaser', 'customer_po', 'none'), ('Purchaser', 'vendor_invoice', 'edit'), ('Purchaser', 'users', 'none'),
  ('Sales', 'customers', 'edit'), ('Sales', 'vendors', 'none'), ('Sales', 'products', 'view'),
  ('Sales', 'customer_po', 'edit'), ('Sales', 'vendor_invoice', 'none'), ('Sales', 'users', 'none'),
  ('Store', 'customers', 'view'), ('Store', 'vendors', 'view'), ('Store', 'products', 'view'),
  ('Store', 'customer_po', 'view'), ('Store', 'vendor_invoice', 'view'), ('Store', 'users', 'none'),
  ('Production', 'customers', 'none'), ('Production', 'vendors', 'none'), ('Production', 'products', 'view'),
  ('Production', 'customer_po', 'view'), ('Production', 'vendor_invoice', 'none'), ('Production', 'users', 'none');
