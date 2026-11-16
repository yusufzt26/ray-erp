-- Product categories added by users (the built-in FG, SA, CP, RM, BO, CN, PK stay in code).
-- The code is also the item code prefix, e.g. TF-00001.
CREATE TABLE product_categories (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
