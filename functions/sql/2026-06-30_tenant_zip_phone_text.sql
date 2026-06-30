-- Phone numbers and zip/postal codes are identifiers, not numeric values.
-- A US 10-digit phone number (for example 5556621234) exceeds PostgreSQL integer's
-- 2147483647 max value, and postal codes can contain leading zeroes or extensions.
ALTER TABLE app.tenants
  ALTER COLUMN "Zip" TYPE text USING NULLIF("Zip"::text, ''),
  ALTER COLUMN "Phone" TYPE text USING NULLIF("Phone"::text, '');
