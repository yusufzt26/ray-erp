-- Regular production or NPD (new product development), on every sales and purchase document and invoice.
ALTER TABLE documents ADD COLUMN segment TEXT NOT NULL DEFAULT 'Regular';
ALTER TABLE invoices ADD COLUMN segment TEXT NOT NULL DEFAULT 'Regular';
CREATE INDEX idx_documents_segment ON documents(doc_type, segment);
