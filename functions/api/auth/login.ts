import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

type LoginBody = { id?: string; password?: string };

// POST /api/auth/login  (v2 – single cookie: __Host-rp_session, 24h)
// This version emits a debug trail in a response header and JSON so the browser can log it.
export const onRequestPost: PagesFunction = async ({ request, env }) => {
  const dbg: string[] = [];
  const started = new Date().toISOString();
  dbg.push(`login:start:${started}`);

  try {
    const { id, password } = (await request.json().catch(() => ({}))) as LoginBody;
    dbg.push(`login:body:id:${id ? String(id).slice(0, 64) : "missing"}`);
    if (!id || !password) return send(400, { error: "Missing id or password." });

    const sql = neon(env.DATABASE_URL as string);
    dbg.push("login:query:begin");
    const rows = await sql<{
      user_id: string;
      login_id: string;
      email: string | null;
      password_hash: string | null;
    }[]>`
      SELECT user_id, login_id, email, password_hash
      FROM app.users
      WHERE LOWER(login_id) = LOWER(${id}) OR LOWER(email) = LOWER(${id})
      LIMIT 1
    `;
    dbg.push(`login:query:rows:${rows.length}`);

    if (rows.length === 0) return send(401, { error: "invalid_credentials" });
    const u = rows[0];
    if (!u.password_hash) return send(401, { error: "invalid_credentials" });

    dbg.push("login:password:compare");
    const ok = await bcrypt.compare(password, u.password_hash);
    dbg.push(`login:password:ok:${ok}`);
    if (!ok) return send(401, { error: "invalid_credentials" });

    // 24h token
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 24 * 60 * 60;
    const payload = { sub: u.user_id, lid: u.login_id, email: u.email, iat: now, exp };
    dbg.push("login:jwt:sign");
    const token = await signJwt(payload, String(env.JWT_SECRET));

    // New single cookie (host-only): __Host-rp_session
    const sessionCookie = [
      `__Host-rp_session=${token}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${24 * 60 * 60}`
    ].join("; ");

    // Clear legacy cookies
    const clearRpJwtHost = [
      "rp_jwt=",
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    ].join("; ");
    const clearRpJwtDomain = [
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
      "cache-control": "no-store",
      "x-rp-debug": dbg.join("|"),
    });
    headers.append("set-cookie", sessionCookie);
    headers.append("set-cookie", clearRpJwtHost);
    headers.append("set-cookie", clearRpJwtDomain);

    dbg.push("login:done:200");
    return new Response(
      JSON.stringify({
        user: { user_id: u.user_id, login_id: u.login_id, email: u.email },
        debug: dbg,
      }),
      { status: 200, headers }
    );
  } catch (err: any) {
    dbg.push(`login:error:${err?.message ?? "unknown"}`);
    return send(500, { error: err?.message || "Server error.", debug: dbg });
  }

  function send(status: number, body: Record<string, unknown>) {
    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-rp-debug": dbg.join("|"),
    });
    return new Response(JSON.stringify({ ...body, debug: dbg }), { status, headers });
  }
};

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
