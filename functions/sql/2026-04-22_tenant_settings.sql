create table if not exists app.tenant_settings (
  tenant_setting_id                      uuid primary key default gen_random_uuid(),
  tenant_id                              uuid not null unique references app.tenants(tenant_id) on delete cascade,
  state_code                             text not null default 'CA',
  consecutive_lunch_hours_required       numeric(5,2) not null default 5.00,
  default_lunch_minutes                  integer not null default 30,
  settings_json                          jsonb not null default '{}'::jsonb,
  created_at                             timestamptz not null default now(),
  updated_at                             timestamptz not null default now(),
  created_by_user_id                     uuid references app.users(user_id),
  updated_by_user_id                     uuid references app.users(user_id),
  constraint tenant_settings_state_code_chk
    check (length(trim(state_code)) between 2 and 3),
  constraint tenant_settings_consecutive_lunch_hours_chk
    check (consecutive_lunch_hours_required > 0 and consecutive_lunch_hours_required <= 24),
  constraint tenant_settings_default_lunch_minutes_chk
    check (default_lunch_minutes >= 0 and default_lunch_minutes <= 180)
);

create index if not exists idx_tenant_settings_state_code
  on app.tenant_settings(state_code);

insert into app.tenant_settings (tenant_id)
select t.tenant_id
from app.tenants t
left join app.tenant_settings ts on ts.tenant_id = t.tenant_id
where ts.tenant_id is null;
