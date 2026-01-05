// POST /api/cash-ledger/save
// Body: { from_location, to_location, amount, notes }
// Phase 1: simple inserts, required notes for Purchase, validate from != to

import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Minimal HS256 verify (same as cash-drawer/save.ts)
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

function asMoney(n: any) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

const ALLOWED_LOCATIONS = new Set([
  "Drawer 1",
  "Drawer 2",
  "Safe",
  "Bank",
  "Purchase",
]);

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const body = await request.json();

    const from_location = String(body.from_location || "").trim();
    const to_location = String(body.to_location || "").trim();
    const amount = asMoney(body.amount);
    const notes = body.notes ? String(body.notes).slice(0, 2000) : null;

    if (!from_location || !to_location) return json({ error: "missing_location" }, 400);
    if (!ALLOWED_LOCATIONS.has(from_location) || !ALLOWED_LOCATIONS.has(to_location)) {
      return json({ error: "bad_location" }, 400);
    }
    if (from_location === to_location) return json({ error: "same_location" }, 400);
    if (amount <= 0) return json({ error: "bad_amount" }, 400);

    // Require notes if Purchase is involved (Phase 1)
    if ((from_location === "Purchase" || to_location === "Purchase") && !notes) {
      return json({ error: "notes_required_for_purchase" }, 400);
    }

    // Resolve user + tenant
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token || !env.JWT_SECRET) return json({ error: "unauthorized" }, 401);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const user_id = String((payload as any).sub);

    const sql = neon(env.DATABASE_URL);

    // Find tenant_id for current user via memberships
    const rowsTenant = await sql/*sql*/`
      SELECT tenant_id
      FROM app.memberships
      WHERE user_id = ${user_id}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    const tenant_id = rowsTenant[0]?.tenant_id;
    if (!tenant_id) return json({ error: "no_tenant" }, 403);

    const rows = await sql/*sql*/`
      INSERT INTO app.cash_ledger
        (tenant_id, user_id, from_location, to_location, amount, notes, created_at, updated_at)
      VALUES
        (${tenant_id}, ${user_id}, ${from_location}, ${to_location}, ${amount}, ${notes}, now(), now())
      RETURNING ledger_id, created_at, from_location, to_location, amount
    `;

    return json({ ok: true, row: rows[0] });
  } catch (e: any) {
    return json({ error: e?.message || "ledger_save_failed" }, 500);
  }
};

