import { neon } from "@neondatabase/serverless";
type SessionUser = { user_id: string; login_id: string; email: string | null };

// GET /api/auth/session -> 200 { user, active_tenant_id } OR 401 { reason } (with debug trail)
export const onRequestGet: PagesFunction = async ({ request, env }) => {
  const dbg: string[] = [];
  const started = new Date().toISOString();
  dbg.push(`session:start:${started}`);

  try {
    const cookieHeader = request.headers.get("cookie") || "";
    dbg.push(`session:cookies:${cookieHeader ? "present" : "missing"}`);

    const token = readCookie(cookieHeader, "__Host-rp_session");
    dbg.push(`session:token:${token ? "found" : "none"}`);
    if (!token) return send(401, { reason: "no_cookie" });

    dbg.push("session:verify:begin");
    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    dbg.push("session:verify:ok");

    const user: SessionUser = {
      user_id: String((payload as any).sub),
      login_id: String((payload as any).lid),
      email: (payload as any).email ?? null,
    };

    // Read active tenant from secure cookie. If it is missing/stale, select an
    // active tenant membership so tenant-scoped screens can keep sending
    // x-tenant-id even after users gain additional tenant memberships.
    const sql = neon(String(env.DATABASE_URL));
    let active_tenant_id = readCookie(cookieHeader, "__Host-rp_tenant") || null;
    let setCookieHeader: string | null = null;

    if (active_tenant_id) {
      if (!isUuid(active_tenant_id)) {
        dbg.push("session:tenant-cookie:malformed");
        active_tenant_id = null;
      } else {
        const validRows = await sql/*sql*/`
          WITH accessible_tenants AS (
            SELECT t.tenant_id
            FROM app.tenants t
            WHERE EXISTS (
              SELECT 1 FROM app.platform_memberships pm
              WHERE pm.user_id = ${user.user_id} AND pm.active = true
            )
            UNION
            SELECT t.tenant_id
            FROM app.organization_memberships om
            JOIN app.businesses b ON b.organization_id = om.organization_id
            JOIN app.tenants t ON t.business_id = b.business_id
            WHERE om.user_id = ${user.user_id} AND om.active = true
            UNION
            SELECT t.tenant_id
            FROM app.business_memberships bm
            JOIN app.tenants t ON t.business_id = bm.business_id
            WHERE bm.user_id = ${user.user_id} AND bm.active = true
            UNION
            SELECT m.tenant_id
            FROM app.memberships m
            WHERE m.user_id = ${user.user_id} AND m.active = true
          )
          SELECT 1
          FROM accessible_tenants
          WHERE tenant_id = ${active_tenant_id}::uuid
          LIMIT 1
        `;
        if (validRows.length === 0) {
          dbg.push("session:tenant-cookie:invalid");
          active_tenant_id = null;
        } else {
          dbg.push("session:tenant-cookie:valid");
        }
      }
    }

    if (!active_tenant_id) {
      const rows = await sql/*sql*/`
        WITH accessible_tenants AS (
          SELECT t.tenant_id, t.created_at, 1 AS priority
          FROM app.tenants t
          WHERE EXISTS (
            SELECT 1 FROM app.platform_memberships pm
            WHERE pm.user_id = ${user.user_id} AND pm.active = true
          )
          UNION
          SELECT t.tenant_id, t.created_at, 2 AS priority
          FROM app.organization_memberships om
          JOIN app.businesses b ON b.organization_id = om.organization_id
          JOIN app.tenants t ON t.business_id = b.business_id
          WHERE om.user_id = ${user.user_id} AND om.active = true
          UNION
          SELECT t.tenant_id, t.created_at, 3 AS priority
          FROM app.business_memberships bm
          JOIN app.tenants t ON t.business_id = bm.business_id
          WHERE bm.user_id = ${user.user_id} AND bm.active = true
          UNION
          SELECT m.tenant_id, m.created_at, 4 AS priority
          FROM app.memberships m
          WHERE m.user_id = ${user.user_id} AND m.active = true
        )
        SELECT tenant_id
        FROM accessible_tenants
        ORDER BY priority, created_at DESC
        LIMIT 1
      `;
      if (rows.length === 1) {
        active_tenant_id = String(rows[0].tenant_id);
        setCookieHeader = tenantCookie(active_tenant_id);
        dbg.push("session:auto-tenant:set");
      } else {
        dbg.push("session:auto-tenant:none");
      }
    }

    dbg.push("session:done:200");
    return send(200, { user, active_tenant_id }, setCookieHeader);
  } catch (e: any) {
    const reason = e?.message || "verify_failed";
    dbg.push(`session:error:${reason}`);
    return send(401, { reason });
  }

  function send(status: number, body: Record<string, any>, setCookieHeader: string | null = null) {
    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
      "vary": "Cookie",
      "x-rp-debug": dbg.join("|"),
    });
    if (setCookieHeader) headers.append("set-cookie", setCookieHeader);
    return new Response(JSON.stringify({ ...body, debug: dbg }), { status, headers });
  }
};

function tenantCookie(tenant_id: string) {
  return `__Host-rp_tenant=${encodeURIComponent(
    tenant_id
  )}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Minimal HS256 verify
async function verifyJwt(token: string, secret: string): Promise<Record<string, any>> {
  const enc = new TextEncoder();
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("bad_token");
  const base64urlToBytes = (str: string) => {
    const pad = "=".repeat((4 - (str.length % 4)) % 4);
    const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload;
}
