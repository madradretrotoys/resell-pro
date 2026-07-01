-- Add Resell Pro platform-level access for internal super users.
-- Customer access remains in organization_memberships, business_memberships, and memberships.
CREATE TABLE IF NOT EXISTS app.platform_memberships (
  user_id uuid PRIMARY KEY REFERENCES app.users(user_id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'platform_support' CHECK (role IN ('platform_owner', 'platform_admin', 'platform_support', 'platform_readonly')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_memberships_active_role
  ON app.platform_memberships (active, role);
