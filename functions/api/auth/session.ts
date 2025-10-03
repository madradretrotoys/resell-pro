type SessionUser = { user_id: string; login_id: string; email: string | null };

/** GET /api/auth/session -> { user: SessionUser|null, memberships: [], reason?: string } */
export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "rp_jwt");
    if (!token) return json({ user: null, memberships: [], reason: "no_cookie" });

    const secret = String(env.JWT_SECRET ?? "");
    if (!secret) return json({ user: null, memberships: [], reason: "missing_jwt_secret_env" });

    let payload: any;
    try {
      payload = await verifyJwt(token, secret);
    } catch (e: any) {
      return json({ user: null, memberships: [], reason: e?.message || "verify_failed" });
    }

    if (!payload || typeof payload !== "object") {
      return json({ user: null, memberships: [], reason: "bad_payload" });
    }

    const user: SessionUser = {
      user_id: String(payload.sub),
      login_id: String(payload.lid),
      email: payload.email ?? null,
    };

    return json({ user, memberships: [] });
  } catch (e: any) {
    return json({ user: null, memberships: [], reason: e?.message || "unknown_error" });
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "vary": "Cookie"
    },
  });
}

// Simple cookie parser (avoids tricky RegExp escaping)
function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// --- Minimal HS256 JWT verify ---
async function verifyJwt(token: string, secret: string): Promise<any> {
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
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload;
}
