-- New users must be active immediately so authenticated employees can use
-- features whose authorization checks app.users.is_active, including timekeeping.
UPDATE app.users
SET is_active = true
WHERE is_active IS NULL;

ALTER TABLE app.users
  ALTER COLUMN is_active SET DEFAULT true,
  ALTER COLUMN is_active SET NOT NULL;
