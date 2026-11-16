-- Terms & conditions typed on one quotation (blank = the default from Company Settings).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS terms TEXT;
