import type { PagesFunction } from "@cloudflare/workers-types";
import { neon } from "@neondatabase/serverless";
import { onRequestPost as subscribe } from "./subscribe"; // reuse helpers if you prefer (optional)

// Minimal standalone (mirrors subscribe.ts)
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
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const body = await request.json().catch(() => ({}));
    const marketplace_id = Number((body && body.marketplace_id) || 0);
    if (!marketplace_id) return json({ ok: false, error: "missing_marketplace_id" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const actor = await sql<{ role: "owner"|"admin"|"manager"|"clerk"; active: boolean; can_settings: boolean|null }[]>`
      SELECT m.role, m.active, COALESCE(p.can_settings, false) AS can_settings
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;
    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const role = actor[0].role;
    const allowSettings = role === "owner" || role === "admin" || role === "manager" || !!actor[0].can_settings;
    if (!allowSettings) return json({ ok: false, error: "forbidden" }, 403);

    await sql/*sql*/`
      INSERT INTO app.tenant_marketplaces (tenant_id, marketplace_id, enabled)
      VALUES (${tenant_id}, ${marketplace_id}, false)
      ON CONFLICT (tenant_id, marketplace_id)
      DO UPDATE SET enabled = false, updated_at = now()
    `;

    return json({ ok: true, marketplace_id, enabled: false });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
