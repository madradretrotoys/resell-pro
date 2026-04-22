import { neon } from "@neondatabase/serverless";

type Sql = ReturnType<typeof neon>;

export function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, any>> {
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
  return payload as Record<string, any>;
}

export async function requireSessionActor(request: Request, env: any, json: (data: any, status?: number) => Response) {
  const cookieHeader = request.headers.get("cookie") || "";
  const token = readCookie(cookieHeader, "__Host-rp_session");
  if (!token) return { error: json({ ok: false, error: "no_cookie" }, 401) };

  const payload = await verifyJwt(token, String(env.JWT_SECRET));
  const actor_user_id = String((payload as any).sub || "");
  if (!actor_user_id) return { error: json({ ok: false, error: "bad_token" }, 401) };

  return { actor_user_id };
}

export async function getTenantActor(sql: Sql, tenant_id: string, actor_user_id: string) {
  const rows = await sql<{ role: string; active: boolean; can_settings: boolean }[]>`
    SELECT m.role, m.active, COALESCE(p.can_settings, false) AS can_settings
    FROM app.memberships m
    LEFT JOIN app.permissions p ON p.user_id = m.user_id
    WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
    LIMIT 1
  `;
  return rows[0] || null;
}

export function canManageTenantSettings(actor: { role: string; can_settings: boolean } | null) {
  if (!actor) return false;
  return actor.role === "owner" || actor.role === "admin" || actor.role === "manager" || !!actor.can_settings;
}
