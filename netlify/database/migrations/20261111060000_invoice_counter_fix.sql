-- Once only: if the latest invoices were deleted, bring the invoice number series back to the highest invoice that still exists.
UPDATE counters c SET value = s.top
FROM (
  SELECT 'invoice_' || substring(inv_no from '/(\d{2})-\d+$') AS name, MAX(substring(inv_no from '-(\d+)$')::int) AS top
  FROM invoices WHERE inv_no ~ '/\d{2}-\d+$' GROUP BY 1
) s
WHERE c.name = s.name AND c.value > s.top;
