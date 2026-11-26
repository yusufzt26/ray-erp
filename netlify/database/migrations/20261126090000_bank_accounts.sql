-- The company's bank accounts. Every uploaded statement line belongs to one account, so the app can show
-- each account's balance, check it against the bank's own balance column and post transfers between them.
CREATE TABLE bank_accounts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,                             -- short name, e.g. "HDFC current"
  bank_name TEXT,
  account_no TEXT,
  ifsc TEXT,
  branch TEXT,
  opening_balance DOUBLE PRECISION,               -- balance before the first statement line; empty = read from the statement
  opening_date DATE,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bank_lines ADD COLUMN account_id INTEGER REFERENCES bank_accounts(id);
ALTER TABLE bank_lines ADD COLUMN transfer_line_id INTEGER;   -- the other side of a transfer between own accounts
CREATE INDEX idx_bank_account ON bank_lines(account_id, txn_date);

-- lines uploaded before accounts existed go to one account the user can rename
INSERT INTO bank_accounts (name) SELECT 'Main bank account' WHERE EXISTS (SELECT 1 FROM bank_lines);
UPDATE bank_lines SET account_id = (SELECT MIN(id) FROM bank_accounts) WHERE account_id IS NULL;

-- the same line uploaded twice is skipped, per account; two real entries that differ only by reference are kept
DROP INDEX IF EXISTS ux_bank_line;
CREATE UNIQUE INDEX ux_bank_line ON bank_lines (COALESCE(account_id, 0), txn_date, description, COALESCE(ref, ''), debit, credit, COALESCE(balance, -1));

-- expenses typed in by hand (paid in cash) have no bank line
ALTER TABLE expenses ADD COLUMN paid_by TEXT;     -- Cash | Bank (from statement)
