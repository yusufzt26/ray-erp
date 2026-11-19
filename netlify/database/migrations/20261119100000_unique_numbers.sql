-- No number used twice: our document numbers per type, and a customer's PO number per customer.
-- Each index is added only when the saved data has no duplicates yet (the app refuses new ones either way).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documents WHERE ref_no IS NOT NULL GROUP BY doc_type, UPPER(ref_no) HAVING COUNT(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_ref ON documents (doc_type, UPPER(ref_no)) WHERE ref_no IS NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM documents WHERE doc_type = 'customer_po' AND party_id IS NOT NULL AND COALESCE(doc_no, '') <> ''
      GROUP BY party_id, REGEXP_REPLACE(UPPER(doc_no), '[^A-Z0-9]', '', 'g') HAVING COUNT(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_po_no ON documents (party_id, REGEXP_REPLACE(UPPER(doc_no), '[^A-Z0-9]', '', 'g'))
      WHERE doc_type = 'customer_po' AND party_id IS NOT NULL AND COALESCE(doc_no, '') <> '';
  END IF;
END $$;
