-- An advance can be paid / received against a purchase order or a customer's sales order.
-- It is used for the invoices made from that order first.
ALTER TABLE payments ADD COLUMN order_id INTEGER;
CREATE INDEX idx_payments_order ON payments(order_id);
