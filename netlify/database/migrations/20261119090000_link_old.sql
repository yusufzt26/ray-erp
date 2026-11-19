-- Setup period for linking earlier documents to the ones they came from (Company Settings can change or clear it).
INSERT INTO settings (key, value) VALUES ('link_old_until', '2026-12-03') ON CONFLICT (key) DO NOTHING;
