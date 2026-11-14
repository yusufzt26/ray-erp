-- Terms printed on quotations (editable in Company Settings). Invoices keep their own terms.
INSERT INTO settings (key, value) VALUES ('quotation_terms', E'1. Prices are ex-works, packed in standard boxes. GST extra as applicable; freight extra unless stated.\n2. Payment within 30 days of invoice. This offer is valid for 30 days from the quotation date.\n3. Delivery 2-3 weeks from receipt of PO. NPD parts: samples after drawing approval; fixture / tooling cost, if any, charged extra.')
ON CONFLICT (key) DO NOTHING;
