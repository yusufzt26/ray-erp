-- E-way bill: transport details and the e-way bill number, kept on the invoice or challan.
-- eway = {"reason", "mode", "vehicle_no", "transporter_id", "transporter_name", "distance", "trans_doc_no", "trans_doc_date", "ewb_no", "ewb_date"}
ALTER TABLE invoices ADD COLUMN eway JSONB;
ALTER TABLE documents ADD COLUMN eway JSONB;

-- Road distance from our factory, remembered per customer.
ALTER TABLE customers ADD COLUMN distance_km INTEGER;
