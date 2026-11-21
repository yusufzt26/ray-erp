-- Weekly / monthly production plans. The planner lists what to make; the floor logs
-- what got finished. Each finished entry is also a Production stock entry (same batch),
-- so stock goes up for the product and down for its material per piece.
CREATE TABLE production_plans (
  id SERIAL PRIMARY KEY,
  period TEXT NOT NULL,                   -- week | month
  start_date DATE NOT NULL,               -- Monday of the week, or 1st of the month
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',   -- Draft | Released
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (period, start_date)
);

CREATE TABLE production_plan_lines (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES production_plans(id) ON DELETE CASCADE,
  line_no INTEGER,
  product_id INTEGER NOT NULL REFERENCES products(id),
  planned_qty DOUBLE PRECISION NOT NULL,
  target_date DATE,
  order_id INTEGER,                       -- optional sales order (customer PO) this is made for
  notes TEXT
);
CREATE INDEX idx_plan_lines_plan ON production_plan_lines(plan_id);

CREATE TABLE production_logs (
  id SERIAL PRIMARY KEY,
  line_id INTEGER NOT NULL REFERENCES production_plan_lines(id) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  batch TEXT,                             -- the stock_moves batch made with it
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_production_logs_line ON production_logs(line_id);

INSERT INTO role_permissions (role, module, level) VALUES
  ('Production', 'production', 'edit'), ('Store', 'production', 'edit'),
  ('Sales', 'production', 'view'), ('Purchaser', 'production', 'view'), ('Accounts', 'production', 'view')
ON CONFLICT (role, module) DO NOTHING;
