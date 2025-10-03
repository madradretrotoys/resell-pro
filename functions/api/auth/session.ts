type SessionUser = { user_id: string; login_id: string; email: string | null };

/** GET /api/auth/session -> { user: SessionUser|null, memberships: [] } */
export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const token = getCookie(request.headers.get("cookie") || "", "rp_jwt");
    if (!token) return json({ user: null, memberships: [] });

    const payload = await verifyJwt(token, env.JWT_SECRET as string).catch(() => null);
    if (!payload || typeof payload !== "object") return json({ user: null, memberships: [] });

    const user: SessionUser = {
      user_id: String((payload as any).sub),
      login_id: String((payload as any).lid),
      email: (payload as any).email ?? null,
    };
    return json({ user, memberships: [] });
  } catch {
    return json({ user: null, memberships: [] });
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function getCookie(cookieHeader: string, name: string): string | null {
  const m = cookieHeader.match(new RegExp(`(?:^|; )${name.replace(/([.$?*|{}()\\[\\]\\\\/+^])/g, "\\$1")}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// --- Minimal HS256 JWT verify ---
async function verifyJwt(token: string, secret: string): Promise<unknown> {
  const enc = new TextEncoder();
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("bad token");

  const base64urlToBytes = (str: string) => {
    const pad = "=".repeat((4 - (str.length % 4)) % 4);
    const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };

  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad sig");

  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if (payload?.exp && Date.now() / 1000 > payload.exp) throw new Error("expired");
  return payload;
}
