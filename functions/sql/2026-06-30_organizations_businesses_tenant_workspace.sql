-- Adds the customer account hierarchy above existing tenants/workspaces.
-- Existing tenant-scoped tables and API behavior remain unchanged: tenant_id
-- continues to be the operational workspace/location boundary.

CREATE TABLE IF NOT EXISTS app.organizations (
  organization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_by_user_id uuid NULL REFERENCES app.users(user_id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES app.users(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT organizations_slug_not_blank CHECK (length(trim(slug)) > 0),
  CONSTRAINT organizations_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE IF NOT EXISTS app.businesses (
  business_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(organization_id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by_user_id uuid NULL REFERENCES app.users(user_id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES app.users(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT businesses_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT businesses_slug_not_blank CHECK (length(trim(slug)) > 0),
  CONSTRAINT businesses_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT businesses_org_slug_unique UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS app.organization_memberships (
  organization_id uuid NOT NULL REFERENCES app.organizations(organization_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT organization_memberships_role_check CHECK (role IN ('owner', 'admin', 'manager', 'viewer'))
);

CREATE TABLE IF NOT EXISTS app.business_memberships (
  business_id uuid NOT NULL REFERENCES app.businesses(business_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id),
  CONSTRAINT business_memberships_role_check CHECK (role IN ('owner', 'admin', 'manager', 'viewer'))
);

ALTER TABLE app.tenants
  ADD COLUMN IF NOT EXISTS business_id uuid NULL REFERENCES app.businesses(business_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_organization
  ON app.businesses (organization_id, status, name);

CREATE INDEX IF NOT EXISTS idx_organization_memberships_user
  ON app.organization_memberships (user_id, active);

CREATE INDEX IF NOT EXISTS idx_business_memberships_user
  ON app.business_memberships (user_id, active);

CREATE INDEX IF NOT EXISTS idx_tenants_business
  ON app.tenants (business_id, created_at DESC);
