-- Linked documents: Quotation -> Sales Order -> Delivery Challan -> Invoice,
-- Purchase Order -> Goods Receipt (GRN) -> Vendor Invoice.
ALTER TABLE documents ADD COLUMN parent_id INTEGER;
CREATE INDEX idx_documents_parent ON documents(parent_id);
ALTER TABLE invoices ADD COLUMN challan_id INTEGER;
CREATE INDEX idx_invoices_po ON invoices(customer_po_id);
CREATE INDEX idx_invoices_challan ON invoices(challan_id);

-- Every stock movement in one place. Goods come in with a GRN, or with a vendor
-- invoice that has no GRN. Goods go out with a delivery challan, or with a sales
-- invoice that has no challan. So nothing is counted twice.
CREATE VIEW stock_flow AS
  SELECT m.product_id, m.move_date AS day, m.kind, m.ref, m.notes AS party, m.qty, m.id AS src_id, 'manual' AS grp, NULL::text AS href
    FROM stock_moves m
  UNION ALL
  SELECT l.product_id, COALESCE(d.doc_date, d.created_at::date), 'Received (GRN)', d.ref_no, d.party_name, l.qty, l.id, 'in', '#/d/grn/' || d.id
    FROM document_lines l JOIN documents d ON d.id = l.document_id
    WHERE d.doc_type = 'grn' AND d.status <> 'Cancelled' AND l.product_id IS NOT NULL
  UNION ALL
  SELECT l.product_id, COALESCE(d.doc_date, d.created_at::date), 'Received', d.ref_no || COALESCE(' / ' || d.doc_no, ''), d.party_name, l.qty, l.id, 'in', '#/d/vendor_invoice/' || d.id
    FROM document_lines l JOIN documents d ON d.id = l.document_id
    LEFT JOIN documents par ON par.id = d.parent_id
    WHERE d.doc_type = 'vendor_invoice' AND d.status <> 'Cancelled' AND l.product_id IS NOT NULL AND COALESCE(par.doc_type, '') <> 'grn'
  UNION ALL
  SELECT l.product_id, COALESCE(d.doc_date, d.created_at::date), 'Dispatched (DC)', d.ref_no, d.party_name, -l.qty, l.id, 'out', '#/d/delivery_challan/' || d.id
    FROM document_lines l JOIN documents d ON d.id = l.document_id
    WHERE d.doc_type = 'delivery_challan' AND d.status <> 'Cancelled' AND l.product_id IS NOT NULL
  UNION ALL
  SELECT l.product_id, i.inv_date, 'Dispatched', i.inv_no, cu.name, -l.qty, l.id, 'out', '#/invoices/' || i.id
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id LEFT JOIN customers cu ON cu.id = i.customer_id
    WHERE i.status <> 'Cancelled' AND i.challan_id IS NULL AND l.product_id IS NOT NULL;

INSERT INTO role_permissions (role, module, level) VALUES
  ('Purchaser', 'quotation', 'none'), ('Sales', 'quotation', 'edit'), ('Store', 'quotation', 'none'), ('Production', 'quotation', 'none'),
  ('Purchaser', 'delivery_challan', 'none'), ('Sales', 'delivery_challan', 'edit'), ('Store', 'delivery_challan', 'edit'), ('Production', 'delivery_challan', 'view'),
  ('Purchaser', 'purchase_order', 'edit'), ('Sales', 'purchase_order', 'none'), ('Store', 'purchase_order', 'view'), ('Production', 'purchase_order', 'none'),
  ('Purchaser', 'grn', 'edit'), ('Sales', 'grn', 'none'), ('Store', 'grn', 'edit'), ('Production', 'grn', 'view')
ON CONFLICT (role, module) DO NOTHING;
