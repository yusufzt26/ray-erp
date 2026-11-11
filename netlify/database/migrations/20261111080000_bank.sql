-- Bank statement lines uploaded from the bank's Excel/CSV, and what each became.
CREATE TABLE bank_lines (
  id SERIAL PRIMARY KEY,
  txn_date DATE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ref TEXT,
  debit DOUBLE PRECISION NOT NULL DEFAULT 0,      -- money out
  credit DOUBLE PRECISION NOT NULL DEFAULT 0,     -- money in
  balance DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'new',             -- new | done | ignored
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  expense_id INTEGER,
  posted_as TEXT,                                 -- short text shown after posting
  file_name TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- the same line uploaded twice is skipped
CREATE UNIQUE INDEX ux_bank_line ON bank_lines (txn_date, description, debit, credit, COALESCE(balance, -1));
CREATE INDEX idx_bank_status ON bank_lines(status, txn_date);

-- Money in or out that is not a customer or vendor bill: bank charges, salaries, rent, taxes, transfers.
CREATE TABLE expenses (
  id SERIAL PRIMARY KEY,
  day DATE NOT NULL,
  direction TEXT NOT NULL DEFAULT 'out',          -- out = spent, in = other income
  category TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  description TEXT,
  bank_line_id INTEGER,
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_expenses_day ON expenses(day);

-- What the user posted a bank description as, so the same payee is suggested next time.
CREATE TABLE bank_rules (
  key TEXT PRIMARY KEY,                           -- cleaned counterparty words from the description
  kind TEXT NOT NULL,                             -- in | out | expense | ignore
  party_id INTEGER,
  category TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
