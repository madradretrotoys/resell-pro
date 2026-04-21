-- Seed default drawers for existing tenants and auto-seed for new tenants.

insert into app.tenant_drawers (
  tenant_id,
  drawer_name,
  drawer_code,
  currency_code,
  starting_float_default,
  is_active
)
select
  t.tenant_id,
  d.drawer_name,
  d.drawer_code,
  'USD',
  0,
  true
from app.tenants t
cross join (
  values
    ('Drawer 1', 'D1'),
    ('Drawer 2', 'D2'),
    ('Drawer 3', 'D3')
) as d(drawer_name, drawer_code)
where not exists (
  select 1
  from app.tenant_drawers td
  where td.tenant_id = t.tenant_id
);

create or replace function app.seed_default_drawers_for_tenant()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from app.tenant_drawers td where td.tenant_id = new.tenant_id
  ) then
    insert into app.tenant_drawers (
      tenant_id,
      drawer_name,
      drawer_code,
      currency_code,
      starting_float_default,
      is_active
    )
    values
      (new.tenant_id, 'Drawer 1', 'D1', 'USD', 0, true),
      (new.tenant_id, 'Drawer 2', 'D2', 'USD', 0, true),
      (new.tenant_id, 'Drawer 3', 'D3', 'USD', 0, true);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_seed_default_drawers_for_tenant on app.tenants;

create trigger trg_seed_default_drawers_for_tenant
after insert on app.tenants
for each row
execute function app.seed_default_drawers_for_tenant();
