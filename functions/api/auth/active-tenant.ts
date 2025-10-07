// functions/api/auth/active-tenant.ts
import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

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

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const user_id = String((payload as any).sub || "");
    if (!user_id) return json({ ok: false, error: "bad_token" }, 401);

    const body = await request.json().catch(() => ({}));
    const tenant_id = String((body as any).tenant_id || "");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant_id" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const rows = await sql/*sql*/`
      SELECT 1
      FROM app.memberships
      WHERE tenant_id = ${tenant_id} AND user_id = ${user_id} AND active = true
      LIMIT 1
    `;
    if (rows.length === 0) return json({ ok: false, error: "not_a_member" }, 403);

    // Set HttpOnly cookie for active tenant
    const h = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": `__Host-rp_tenant=${encodeURIComponent(
        tenant_id
      )}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
