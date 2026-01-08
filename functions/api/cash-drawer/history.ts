import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

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
  if (payload?.exp && Date.now() / 1000 > payload.exp) throw new Error("expired");
  return payload;
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(env.DATABASE_URL);

    // ✅ Define limit (fixes "limit is not defined")
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") || 30), 100);


    // ✅ Auth
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token || !env.JWT_SECRET) return json({ error: "unauthorized" }, 401);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const uid = String(payload?.sub || "");

    // ✅ Optional permission gate
    const permRows = await sql/*sql*/`
      SELECT can_cash_edit
      FROM app.permissions
      WHERE user_id = ${uid}
      LIMIT 1
    `;
    const can_cash_edit = !!permRows?.[0]?.can_cash_edit;
    if (!can_cash_edit) return json({ error: "forbidden" }, 403);
    
    // ✅ History (NO tenant table)
    const rows = await sql/*sql*/`
      SELECT
        count_id,
        drawer,
        period,
        count_ts,
        coin_total,
        bill_total,
        grand_total,
        notes
      FROM app.cash_drawer_counts
      WHERE drawer = ${drawer}
        AND count_ts >= now() - interval '30 days'
      ORDER BY count_ts DESC
      LIMIT ${limit}
    `;


    return json({ rows });
  } catch (e: any) {
    return json({ error: e?.message || "history_failed" }, 500);
  }
};
