-- Delivery promised as a number of days (quotations: from receipt of PO; purchase orders: from the PO date).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS delivery_days INTEGER;
