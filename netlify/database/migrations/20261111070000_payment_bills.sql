-- Which invoices / vendor bills a payment settles. One payment can settle several bills, and a bill can be
-- paid in parts. Money not tied to a bill is matched to the oldest open bills automatically.
CREATE TABLE payment_allocations (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  bill_id INTEGER NOT NULL,          -- invoices.id for money received, documents.id (vendor_invoice) for money paid
  amount DOUBLE PRECISION NOT NULL
);
CREATE INDEX idx_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX idx_alloc_bill ON payment_allocations(bill_id);
