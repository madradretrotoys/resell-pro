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
    const drawer_name = String((body as any).drawer_name || "").trim();
    const drawer_code_raw = String((body as any).drawer_code || "").trim();
    const location_name = String((body as any).location_name || "").trim() || null;
    const currency_code = String((body as any).currency_code || "USD").trim().toUpperCase();
    const starting_float_default = Number((body as any).starting_float_default ?? 0);

    if (!drawer_name) return json({ ok: false, error: "drawer_name_required" }, 400);
    if (!Number.isFinite(starting_float_default) || starting_float_default < 0) {
      return json({ ok: false, error: "bad_starting_float_default" }, 400);
    }

    const drawer_code = drawer_code_raw || null;

    const sql = neon(String(env.DATABASE_URL));

    const actor = await sql<{ role: string; active: boolean; can_settings: boolean }[]>`
      SELECT m.role, m.active, COALESCE(p.can_settings, false) AS can_settings
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;

    if (actor.length === 0 || actor[0].active === false) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const canManage = actor[0].role === "owner" || actor[0].role === "admin" || actor[0].role === "manager" || !!actor[0].can_settings;
    if (!canManage) return json({ ok: false, error: "forbidden" }, 403);

    const rows = await sql/*sql*/`
      INSERT INTO app.tenant_drawers (
        tenant_id,
        drawer_name,
        drawer_code,
        location_name,
        currency_code,
        starting_float_default,
        is_active,
        created_by_user_id,
        updated_by_user_id
      )
      VALUES (
        ${tenant_id},
        ${drawer_name},
        ${drawer_code},
        ${location_name},
        ${currency_code},
        ${starting_float_default},
        true,
        ${actor_user_id},
        ${actor_user_id}
      )
      RETURNING drawer_id, drawer_name, drawer_code, location_name, currency_code, starting_float_default, is_active
    `;

    return json({ ok: true, drawer: rows[0] });
  } catch (e: any) {
    if (String(e?.message || "").includes("ux_tenant_drawers_tenant_name")) {
      return json({ ok: false, error: "drawer_name_exists" }, 409);
    }
    if (String(e?.message || "").includes("ux_tenant_drawers_tenant_code")) {
      return json({ ok: false, error: "drawer_code_exists" }, 409);
    }
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
