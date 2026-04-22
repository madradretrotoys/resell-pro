alter table app.tenant_settings
  add column if not exists week_starts_on smallint not null default 0;

alter table app.tenant_settings
  drop constraint if exists tenant_settings_week_starts_on_chk;

alter table app.tenant_settings
  add constraint tenant_settings_week_starts_on_chk check (week_starts_on between 0 and 6);
