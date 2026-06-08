-- Ensure employee schedule rows can be marked as a standing/static schedule
-- and looked up by employee without depending on the selected calendar week.
ALTER TABLE app.employee_schedules
  ADD COLUMN IF NOT EXISTS static_schedule boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_employee_schedules_static_user
  ON app.employee_schedules(tenant_id, user_id, static_schedule, business_date DESC, shift_start_at DESC);
