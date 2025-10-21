*** /functions/api/inventory/user-defaults.ts	(nonexistent)
--- /functions/api/inventory/user-defaults.ts	(new)
@@
+// Cloudflare Pages Function (GET/PUT) for per-user marketplace defaults
+// Mirrors meta.ts conventions (cookie presence, x-tenant-id, neon driver).
+import { neon } from "@neondatabase/serverless";
+
+type Env = { DATABASE_URL?: string; NEON_DATABASE_URL?: string };
+
+const j = (data: any, status = 200) =>
+  new Response(JSON.stringify(data), {
+    status,
+    headers: {
+      "content-type": "application/json",
+      "cache-control": "no-store",
+      "vary": "Cookie",
+    },
+  });
+
+// Helper: resolve Neon client; keep simple like meta.ts
+function getSql(env: Env) {
+  const url = env.DATABASE_URL || env.NEON_DATABASE_URL;
+  if (!url) throw new Error("missing_db_url");
+  return neon(url);
+}
+
+// GET  /api/inventory/user-defaults?marketplace=ebay
+export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
+  try {
+    const cookie = request.headers.get("cookie");
+    if (!cookie) return j({ ok: false, error: "no_cookie" }, 401);
+
+    const tenantId = request.headers.get("x-tenant-id") || "";
+    if (!tenantId) return j({ ok: false, error: "no_tenant" }, 400);
+
+    const { searchParams } = new URL(request.url);
+    const marketplace = (searchParams.get("marketplace") || "ebay").toLowerCase();
+
+    // NOTE: we rely on PostgreSQL to identify user via your RLS/session config.
+    // If you tag actor user in your other functions with set_config('app.user_id', ...),
+    // do the same upstream; here we scope only by tenant + marketplace + current_user.
+    const sql = getSql(env);
+
+    // Expect table: app.user_marketplace_defaults(tenant_id uuid, user_id uuid, marketplace_slug text, defaults jsonb, updated_at timestamptz)
+    const rows = await sql/*sql*/`
+      SELECT defaults
+      FROM app.user_marketplace_defaults
+      WHERE tenant_id = ${tenantId} AND marketplace_slug = ${marketplace}
+        AND user_id = current_setting('app.user_id', true)::uuid
+      LIMIT 1
+    `;
+
+    const defaults = rows?.[0]?.defaults || {};
+    return j({ ok: true, marketplace, defaults });
+  } catch (e: any) {
+    const msg = e?.message || String(e);
+    return j({ ok: false, error: "server_error", message: msg }, msg === "missing_db_url" ? 500 : 500);
+  }
+};
+
+// PUT  /api/inventory/user-defaults?marketplace=ebay
+// Body: { defaults: {...} }
+export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
+  try {
+    const cookie = request.headers.get("cookie");
+    if (!cookie) return j({ ok: false, error: "no_cookie" }, 401);
+
+    const tenantId = request.headers.get("x-tenant-id") || "";
+    if (!tenantId) return j({ ok: false, error: "no_tenant" }, 400);
+
+    const { searchParams } = new URL(request.url);
+    const marketplace = (searchParams.get("marketplace") || "ebay").toLowerCase();
+
+    const { defaults: raw } = await request.json().catch(() => ({}));
+    if (!raw || typeof raw !== "object") return j({ ok: false, error: "bad_payload" }, 400);
+
+    // EXPLICITLY DROP per-item price fields: auto_accept_amount, minimum_offer_amount
+    const { auto_accept_amount, minimum_offer_amount, ...safe } = raw;
+
+    const sql = getSql(env);
+    // Upsert on (tenant_id, user_id, marketplace_slug)
+    const rows = await sql/*sql*/`
+      INSERT INTO app.user_marketplace_defaults(tenant_id, user_id, marketplace_slug, defaults)
+      VALUES (
+        ${tenantId},
+        current_setting('app.user_id', true)::uuid,
+        ${marketplace},
+        ${safe}
+      )
+      ON CONFLICT (tenant_id, user_id, marketplace_slug)
+      DO UPDATE SET defaults = EXCLUDED.defaults, updated_at = NOW()
+      RETURNING defaults
+    `;
+    return j({ ok: true, marketplace, defaults: rows?.[0]?.defaults || safe });
+  } catch (e: any) {
+    const msg = e?.message || String(e);
+    return j({ ok: false, error: "server_error", message: msg }, msg === "missing_db_url" ? 500 : 500);
+  }
+};
