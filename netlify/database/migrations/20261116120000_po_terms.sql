-- Terms printed on purchase orders to vendors (editable in Company Settings and on each PO).
INSERT INTO settings (key, value) VALUES ('po_terms', E'1. Material as per our drawing / specification; supply with test certificate and our PO number on the invoice and challan.\n2. Rejected material will be returned at the supplier''s cost. Quantity beyond PO will not be accepted.\n3. Payment within 45 days of receipt of material and GST invoice.')
ON CONFLICT (key) DO NOTHING;
