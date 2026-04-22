-- Step-1 multi-tenant foundation for configurable drawers, business hours,
-- and employee schedules (prep for scheduling UI).

-- 1) Drawer master (tenant-defined, replaces hard-coded drawers)
create table if not exists app.tenant_drawers (
  drawer_id               uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references app.tenants(tenant_id) on delete cascade,
  drawer_name             text not null,
  drawer_code             text,
  location_name           text,
  currency_code           text not null default 'USD',
  starting_float_default  numeric(12,2),
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by_user_id      uuid references app.users(user_id),
  updated_by_user_id      uuid references app.users(user_id),
  constraint tenant_drawers_name_chk check (length(trim(drawer_name)) > 0),
  constraint tenant_drawers_code_chk check (drawer_code is null or length(trim(drawer_code)) > 0),
  constraint tenant_drawers_currency_chk check (length(trim(currency_code)) = 3)
);

create unique index if not exists ux_tenant_drawers_tenant_name
  on app.tenant_drawers(tenant_id, lower(drawer_name));

create unique index if not exists ux_tenant_drawers_tenant_code
  on app.tenant_drawers(tenant_id, lower(drawer_code))
  where drawer_code is not null;

create index if not exists idx_tenant_drawers_tenant_active
  on app.tenant_drawers(tenant_id, is_active);

-- 2) Drawer assignments / sessions (who has which drawer and when)
create table if not exists app.drawer_assignments (
  assignment_id             uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references app.tenants(tenant_id) on delete cascade,
  drawer_id                 uuid not null references app.tenant_drawers(drawer_id) on delete restrict,
  user_id                   uuid not null references app.users(user_id) on delete restrict,
  business_date             date not null,
  starts_at                 timestamptz,
  ends_at                   timestamptz,
  status                    text not null default 'scheduled',
  opening_amount_expected   numeric(12,2),
  opening_amount_counted    numeric(12,2),
  closing_amount_expected   numeric(12,2),
  closing_amount_counted    numeric(12,2),
  variance_amount           numeric(12,2),
  notes                     text,
  assigned_by_user_id       uuid references app.users(user_id),
  closed_by_user_id         uuid references app.users(user_id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint drawer_assignments_status_chk
    check (status in ('scheduled', 'active', 'closed', 'voided')),
  constraint drawer_assignments_time_window_chk
    check (starts_at is null or ends_at is null or ends_at > starts_at)
);

create index if not exists idx_drawer_assignments_tenant_date
  on app.drawer_assignments(tenant_id, business_date);

create index if not exists idx_drawer_assignments_drawer
  on app.drawer_assignments(drawer_id, business_date desc);

create index if not exists idx_drawer_assignments_user
  on app.drawer_assignments(user_id, business_date desc);

-- Optional strictness to prevent two active assignments on one drawer at the same time.
-- This keeps rules simple until overlap constraints are added.
create unique index if not exists ux_drawer_assignments_active_drawer
  on app.drawer_assignments(drawer_id)
  where status = 'active';

-- 3) Tenant business hours (weekly recurring)
create table if not exists app.tenant_business_hours (
  business_hour_id         uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references app.tenants(tenant_id) on delete cascade,
  day_of_week              smallint not null,
  is_closed                boolean not null default false,
  open_time                time,
  close_time               time,
  effective_start_date     date,
  effective_end_date       date,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint tenant_business_hours_day_chk
    check (day_of_week between 0 and 6),
  constraint tenant_business_hours_time_chk
    check (
      is_closed = true
      or (open_time is not null and close_time is not null and close_time <> open_time)
    ),
  constraint tenant_business_hours_effective_range_chk
    check (effective_end_date is null or effective_start_date is null or effective_end_date >= effective_start_date)
);

create unique index if not exists ux_tenant_business_hours_tenant_day_effective
  on app.tenant_business_hours(
    tenant_id,
    day_of_week,
    coalesce(effective_start_date, date '1900-01-01')
  );

create index if not exists idx_tenant_business_hours_tenant
  on app.tenant_business_hours(tenant_id);

-- 4) One-off date exceptions (holiday/override)
create table if not exists app.tenant_business_hour_exceptions (
  business_hour_exception_id  uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references app.tenants(tenant_id) on delete cascade,
  exception_date              date not null,
  is_closed                   boolean not null default true,
  open_time                   time,
  close_time                  time,
  reason                      text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint tenant_business_hour_exceptions_time_chk
    check (
      is_closed = true
      or (open_time is not null and close_time is not null and close_time <> open_time)
    )
);

create unique index if not exists ux_tenant_business_hour_exceptions_date
  on app.tenant_business_hour_exceptions(tenant_id, exception_date);

-- 5) Employee schedules (foundation for future screen)
create table if not exists app.employee_schedules (
  schedule_id              uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references app.tenants(tenant_id) on delete cascade,
  user_id                  uuid not null references app.users(user_id) on delete restrict,
  business_date            date,
  shift_start_at           timestamptz not null,
  shift_end_at             timestamptz not null,
  break_minutes            integer not null default 0,
  status                   text not null default 'draft',
  preferred_drawer_id      uuid references app.tenant_drawers(drawer_id) on delete set null,
  notes                    text,
  created_by_user_id       uuid references app.users(user_id),
  updated_by_user_id       uuid references app.users(user_id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint employee_schedules_time_window_chk
    check (shift_end_at > shift_start_at),
  constraint employee_schedules_break_chk
    check (break_minutes >= 0),
  constraint employee_schedules_status_chk
    check (status in ('draft', 'published', 'confirmed', 'completed', 'cancelled'))
);

create index if not exists idx_employee_schedules_tenant_shift
  on app.employee_schedules(tenant_id, shift_start_at, shift_end_at);

create index if not exists idx_employee_schedules_user_shift
  on app.employee_schedules(user_id, shift_start_at desc);

-- optional convenience uniqueness guard for exact duplicate shifts
create unique index if not exists ux_employee_schedules_exact_shift
  on app.employee_schedules(tenant_id, user_id, shift_start_at, shift_end_at);
