-- Material used per piece of a product (e.g. 0.45 MTR of pipe per assembly).
-- Production entries use it to work out the raw material consumed.
CREATE TABLE product_bom (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES products(id),
  qty_per DOUBLE PRECISION NOT NULL,
  UNIQUE (product_id, component_id)
);
CREATE INDEX idx_product_bom_product ON product_bom(product_id);
