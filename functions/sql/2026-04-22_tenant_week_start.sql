alter table app.tenants
  add column if not exists week_starts_on smallint not null default 0;

alter table app.tenants
  drop constraint if exists tenants_week_starts_on_chk;

alter table app.tenants
  add constraint tenants_week_starts_on_chk check (week_starts_on between 0 and 6);
