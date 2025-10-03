import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

type LoginBody = { id?: string; password?: string };

// POST /api/auth/v2/login
export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const { id, password } = (await request.json().catch(() => ({}))) as LoginBody;
    if (!id || !password) return json({ error: "Missing id or password." }, 400);

    const sql = neon(env.DATABASE_URL as string);
    const rows = await sql<{
      user_id: string;
      login_id: string;
      email: string | null;
      password_hash: string | null;
    }[]>`SELECT user_id, login_id, email, password_hash
         FROM app.users
         WHERE LOWER(login_id) = LOWER(${id}) OR LOWER(email) = LOWER(${id})
         LIMIT 1`;

    if (rows.length === 0) return json({ error: "invalid_credentials" }, 401);

    const u = rows[0];
    if (!u.password_hash) return json({ error: "invalid_credentials" }, 401);

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return json({ error: "invalid_credentials" }, 401);

    // 24h token
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 24 * 60 * 60; // 24 hours
    const payload = { sub: u.user_id, lid: u.login_id, email: u.email, iat: now, exp };
    const token = await signJwt(payload, env.JWT_SECRET as string);

    // __Host- cookie (host-only) — new v2 cookie
    const v2Cookie = [
      `__Host-rp_session=${token}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${24 * 60 * 60}`
    ].join("; ");

    // Also kill any legacy domain-scoped cookie in case it exists
    const killLegacyDomain = [
      "rp_jwt=",
      "Path=/",
      "Domain=.resell-pro.pages.dev",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    ].join("; ");

    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    headers.append("set-cookie", v2Cookie);
    headers.append("set-cookie", killLegacyDomain);

    return new Response(JSON.stringify({ user: { user_id: u.user_id, login_id: u.login_id, email: u.email } }), {
      status: 200,
      headers
    });
  } catch (err: any) {
    return json({ error: err?.message || "Server error." }, 500);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

// HS256 JWT signer using Web Crypto
async function signJwt(payload: Record<string, any>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const base64url = (b: ArrayBuffer | string) =>
    btoa(
      String.fromCharCode(
        ...new Uint8Array(typeof b === "string" ? enc.encode(b) : new Uint8Array(b))
      )
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${base64url(sig)}`;
}
