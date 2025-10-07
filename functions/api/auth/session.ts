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

    // Read active tenant from secure cookie if present
    const active_tenant_id = readCookie(cookieHeader, "__Host-rp_tenant") || null;

    dbg.push("session:done:200");
    return send(200, { user, active_tenant_id });
  } catch (e: any) {
    const reason = e?.message || "verify_failed";
    dbg.push(`session:error:${reason}`);
    return send(401, { reason });
  }

  function send(status: number, body: Record<string, any>) {
    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
      "vary": "Cookie",
      "x-rp-debug": dbg.join("|"),
    });
    return new Response(JSON.stringify({ ...body, debug: dbg }), { status, headers });
  }
};

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
