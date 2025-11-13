-- schema: app.item_images (stores original + derived URLs and metadata)
-- FK to inventory.item_id; one item can have many images; one primary.
create table if not exists app.item_images (
  image_id         uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  item_id          uuid not null references app.inventory(item_id) on delete cascade,
  -- immutable storage info
  r2_key           text not null,
  content_type     text,
  bytes            bigint,
  width_px         integer,
  height_px        integer,
  sha256_hex       text,
  -- delivery
  cdn_url          text,           -- our public/read URL via the CDN function
  is_primary       boolean not null default false,
  sort_order       integer not null default 0,
  -- bookkeeping
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists item_images_item_id_idx on app.item_images(item_id);
create index if not exists item_images_tenant_id_idx on app.item_images(tenant_id);

-- ensure at most one primary per item
create unique index if not exists item_images_primary_unique
  on app.item_images(item_id)
  where is_primary = true;
