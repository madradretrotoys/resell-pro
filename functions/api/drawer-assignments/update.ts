import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

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
  return payload as Record<string, any>;
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const body = await request.json().catch(() => ({}));
    const assignment_id = String((body as any).assignment_id || "").trim();
    const starts_at = (body as any).starts_at ? String((body as any).starts_at) : null;
    const ends_at = (body as any).ends_at ? String((body as any).ends_at) : null;
    const status = (body as any).status ? String((body as any).status).trim().toLowerCase() : null;
    const notes = (body as any).notes != null ? String((body as any).notes).slice(0, 2000) : null;

    if (!assignment_id) return json({ ok: false, error: "assignment_id_required" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const actor = await sql<{ role: string; active: boolean; can_settings: boolean }[]>`
      SELECT m.role, m.active, COALESCE(p.can_settings, false) AS can_settings
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;

    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const canManage = actor[0].role === "owner" || actor[0].role === "admin" || actor[0].role === "manager" || !!actor[0].can_settings;
    if (!canManage) return json({ ok: false, error: "forbidden" }, 403);

    const rows = await sql/*sql*/`
      UPDATE app.drawer_assignments
      SET
        starts_at = COALESCE(${starts_at}::timestamptz, starts_at),
        ends_at = COALESCE(${ends_at}::timestamptz, ends_at),
        status = COALESCE(${status}, status),
        notes = COALESCE(${notes}, notes),
        closed_by_user_id = CASE WHEN COALESCE(${status}, status) = 'closed' THEN ${actor_user_id}::uuid ELSE closed_by_user_id END,
        updated_at = now()
      WHERE assignment_id = ${assignment_id}::uuid
        AND tenant_id = ${tenant_id}::uuid
      RETURNING assignment_id, drawer_id, user_id, business_date, starts_at, ends_at, status, notes
    `;

    if (!rows.length) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, assignment: rows[0] });
  } catch (e: any) {
    if (String(e?.message || "").includes("ux_drawer_assignments_active_drawer")) {
      return json({ ok: false, error: "drawer_already_active" }, 409);
    }
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
