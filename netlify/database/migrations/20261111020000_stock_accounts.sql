-- Stock entries made by hand (opening stock, production, issues, corrections).
-- Receipts from vendor invoices and dispatches on sales invoices are counted
-- straight from those documents, so they never get out of step.
CREATE TABLE stock_moves (
  id SERIAL PRIMARY KEY,
  move_date DATE NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty DOUBLE PRECISION NOT NULL,          -- + adds to stock, - takes out
  kind TEXT NOT NULL,                     -- Opening | Production | Consumed | Issue | Adjustment
  batch TEXT,                             -- groups the lines of one entry
  ref TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_stock_moves_product ON stock_moves(product_id);

-- Money received from customers and paid to vendors.
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  direction TEXT NOT NULL,                -- in (from customer) | out (to vendor)
  party_id INTEGER NOT NULL,
  pay_date DATE NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  mode TEXT,                              -- NEFT / RTGS / Cheque / Cash / UPI
  reference TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_payments_party ON payments(direction, party_id);

INSERT INTO role_permissions (role, module, level) VALUES
  ('Purchaser', 'stock', 'view'), ('Sales', 'stock', 'view'), ('Store', 'stock', 'edit'), ('Production', 'stock', 'edit'),
  ('Purchaser', 'accounts', 'none'), ('Sales', 'accounts', 'view'), ('Store', 'accounts', 'none'), ('Production', 'accounts', 'none')
ON CONFLICT (role, module) DO NOTHING;
