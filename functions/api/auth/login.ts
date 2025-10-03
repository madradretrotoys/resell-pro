import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

type LoginBody = { id?: string; password?: string };

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const { id, password } = (await request.json().catch(() => ({}))) as LoginBody;
    if (!id || !password) return json({ error: "Missing id or password." }, 400);

    const sql = neon(env.DATABASE_URL as string);
    const rows = await sql<
      { user_id: string; login_id: string; email: string | null; password_hash: string | null }[]
    >`SELECT user_id, login_id, email, password_hash FROM app.users WHERE login_id = ${id} OR email = ${id} LIMIT 1`;

    if (rows.length === 0) return json({ error: "Invalid credentials." }, 401);
    const u = rows[0];
    if (!u.password_hash) return json({ error: "Password not set." }, 401);

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return json({ error: "Invalid credentials." }, 401);

    // Issue a signed cookie
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 14 * 24 * 60 * 60; // 14 days
    const payload = { sub: u.user_id, lid: u.login_id, email: u.email, iat: now, exp };
    const token = await signJwt(payload, env.JWT_SECRET as string);

    // 1) Set a host-only cookie (works on preview + prod)
    // 2) Proactively remove any old domain-scoped cookie still hanging around
    const hostCookie = [
      `rp_jwt=${token}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${14 * 24 * 60 * 60}`
    ].join("; ");
    
    const killDomainCookie = [
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
    headers.append("set-cookie", hostCookie);
    headers.append("set-cookie", killDomainCookie);
    
    return new Response(JSON.stringify({ ok: true, user: { user_id: u.user_id, login_id: u.login_id, email: u.email } }), {
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
    headers: { "content-type": "application/json" }
  });
}

// HS256 JWT signer using Web Crypto
async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const base64url = (b: ArrayBuffer | string) =>
    btoa(String.fromCharCode(...new Uint8Array(typeof b === "string" ? enc.encode(b) : new Uint8Array(b))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${base64url(sig)}`;
}
