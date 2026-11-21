-- Daily production entries: any number of (partial) entries per day, with shift, operator
-- and remarks. An entry counts toward a plan row when there is one, but can stand alone.
ALTER TABLE production_logs ALTER COLUMN line_id DROP NOT NULL;
ALTER TABLE production_logs DROP CONSTRAINT IF EXISTS production_logs_line_id_fkey;
ALTER TABLE production_logs ADD CONSTRAINT production_logs_line_id_fkey FOREIGN KEY (line_id) REFERENCES production_plan_lines(id) ON DELETE SET NULL;
ALTER TABLE production_logs ADD COLUMN product_id INTEGER REFERENCES products(id);
ALTER TABLE production_logs ADD COLUMN shift TEXT;
ALTER TABLE production_logs ADD COLUMN operator TEXT;
ALTER TABLE production_logs ADD COLUMN remarks TEXT;
UPDATE production_logs g SET product_id = l.product_id FROM production_plan_lines l WHERE l.id = g.line_id AND g.product_id IS NULL;
CREATE INDEX idx_production_logs_date ON production_logs(log_date);
CREATE INDEX idx_production_logs_product ON production_logs(product_id);
