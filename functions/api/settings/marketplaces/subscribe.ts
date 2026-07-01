//begin subscribe.ts
import type { PagesFunction } from "@cloudflare/workers-types";
import { neon } from "@neondatabase/serverless";
import { canManageTenantSettings, getEffectiveTenantActor, isPlatformScopedActor } from "../../../_shared/auth";

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function readCookie(cookieHeader: string, name: string) {
  const m = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : "";
}
function base64urlToBytes(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  return Uint8Array.from(atob(s + "=".repeat(pad)), (c) => c.charCodeAt(0));
}
async function verifyJwt(token: string, secret: string) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("bad_token");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(`${h}.${p}`));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload as Record<string, any>;
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    // Auth
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    // Tenant
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    // Input
    const body = await request.json().catch(() => ({}));
    const marketplace_id = Number((body && body.marketplace_id) || 0);
    if (!marketplace_id) return json({ ok: false, error: "missing_marketplace_id" }, 400);

    // AuthZ
    const sql = neon(String(env.DATABASE_URL));
    const actor = await getEffectiveTenantActor(sql, tenant_id, actor_user_id);
    if (!actor || actor.active === false) return json({ ok: false, error: "forbidden" }, 403);
    const allowSettings = isPlatformScopedActor(actor) ? !!actor.can_settings : canManageTenantSettings(actor);
    if (!allowSettings) return json({ ok: false, error: "forbidden" }, 403);

    await sql/*sql*/`
      INSERT INTO app.tenant_marketplaces (tenant_id, marketplace_id, enabled)
      VALUES (${tenant_id}, ${marketplace_id}, true)
      ON CONFLICT (tenant_id, marketplace_id)
      DO UPDATE SET enabled = true, updated_at = now()
    `;

    // (Optional) audit_log insert here

    return json({ ok: true, marketplace_id, enabled: true });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};

//end subscribe.ts
