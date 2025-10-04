type SessionUser = { user_id: string; login_id: string; email: string | null };

// GET /api/auth/v2/session
export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    const tokens = findAll(cookieHeader, "__Host-rp_session");
    if (tokens.length === 0) return json({ reason: "no_cookie" }, 401);

    const secret = String(env.JWT_SECRET ?? "");
    for (const token of tokens) {
      try {
        const payload = await verifyJwt(token, secret);
        if (payload && typeof payload === "object") {
          const user: SessionUser = {
            user_id: String((payload as any).sub),
            login_id: String((payload as any).lid),
            email: (payload as any).email ?? null,
          };
          return json({ user }, 200);
        }
      } catch {
        // try next token
      }
    }
    return json({ reason: "verify_failed" }, 401);
  } catch (e: any) {
    return json({ reason: e?.message || "unknown_error" }, 401);
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

function findAll(header: string, name: string): string[] {
  const out: string[] = [];
  if (!header) return out;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) out.push(decodeURIComponent(rest.join("=")));
  }
  return out;
}

// HS256 verify
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
