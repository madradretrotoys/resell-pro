import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

// Minimal JWT (HMAC-SHA256) helpers for Workers
const enc = new TextEncoder();
const b64u = (a: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(a instanceof ArrayBuffer ? new Uint8Array(a) : a)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(key: string, data: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
async function signJWT(secret: string, payload: Record<string, unknown>, ttlSec = 60 * 60 * 8) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = { iat: now, exp: now + ttlSec, ...payload };
  const p1 = b64u(enc.encode(JSON.stringify(header)));
  const p2 = b64u(enc.encode(JSON.stringify(body)));
  const sig = b64u(await hmac(secret, `${p1}.${p2}`));
  return `${p1}.${p2}.${sig}`;
}

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

    // ✅ Create a signed session token and set cookie
    const secret = (env.JWT_SECRET as string) || "dev-secret";
    const token = await signJWT(secret, { sub: u.user_id, lid: u.login_id, email: u.email });
    const cookie = [
      `rp_session=${token}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=28800", // 8h
    ].join("; ");

    return new Response(
      JSON.stringify({ ok: true, user: { user_id: u.user_id, login_id: u.login_id, email: u.email } }),
      { status: 200, headers: { "content-type": "application/json", "set-cookie": cookie } }
    );
  } catch (err: any) {
    return json({ error: err?.message || "Server error." }, 500);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
