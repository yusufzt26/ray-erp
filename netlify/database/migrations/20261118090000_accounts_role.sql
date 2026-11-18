-- Accounts role: books payments, bank and invoices; sees orders, stock and masters but cannot change them.
-- Admin can change any of these on the Role Permissions page.
INSERT INTO role_permissions (role, module, level) VALUES
  ('Accounts', 'customers', 'view'), ('Accounts', 'vendors', 'view'), ('Accounts', 'products', 'view'),
  ('Accounts', 'quotation', 'view'), ('Accounts', 'customer_po', 'view'), ('Accounts', 'delivery_challan', 'view'),
  ('Accounts', 'sales_invoice', 'edit'), ('Accounts', 'stock', 'view'), ('Accounts', 'accounts', 'edit'),
  ('Accounts', 'purchase_order', 'view'), ('Accounts', 'grn', 'view'), ('Accounts', 'vendor_invoice', 'edit'),
  ('Accounts', 'users', 'none')
ON CONFLICT (role, module) DO NOTHING;
