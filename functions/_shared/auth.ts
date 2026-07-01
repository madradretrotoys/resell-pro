import { neon } from "@neondatabase/serverless";

type Sql = ReturnType<typeof neon>;

export function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, any>> {
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

export async function requireSessionActor(request: Request, env: any, json: (data: any, status?: number) => Response) {
  const cookieHeader = request.headers.get("cookie") || "";
  const token = readCookie(cookieHeader, "__Host-rp_session");
  if (!token) return { error: json({ ok: false, error: "no_cookie" }, 401) };

  const payload = await verifyJwt(token, String(env.JWT_SECRET));
  const actor_user_id = String((payload as any).sub || "");
  if (!actor_user_id) return { error: json({ ok: false, error: "bad_token" }, 401) };

  return { actor_user_id };
}

export async function getTenantActor(sql: Sql, tenant_id: string, actor_user_id: string) {
  const rows = await sql<{ role: string; active: boolean; can_settings: boolean; can_timekeeping: boolean }[]>`
    SELECT
      m.role,
      m.active,
      COALESCE(p.can_settings, false) AS can_settings,
      COALESCE(p.can_timekeeping, false) AS can_timekeeping
    FROM app.memberships m
    LEFT JOIN app.permissions p ON p.user_id = m.user_id
    WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
    LIMIT 1
  `;
  return rows[0] || null;
}


export async function getPlatformActor(sql: Sql, actor_user_id: string) {
  const rows = await sql<{ role: string; active: boolean }[]>`
    SELECT role, active
    FROM app.platform_memberships
    WHERE user_id = ${actor_user_id}
    LIMIT 1
  `;
  return rows[0] || null;
}

export function canManagePlatform(actor: { role: string; active?: boolean } | null) {
  if (!actor || actor.active === false) return false;
  return actor.role === "platform_owner" || actor.role === "platform_admin";
}

export function canManageTenantSettings(actor: { role: string; can_settings: boolean } | null) {
  if (!actor) return false;
  return actor.role === "owner" || actor.role === "admin" || actor.role === "manager" || !!actor.can_settings;
}

export type TenantRole = "owner" | "admin" | "manager" | "clerk";

export function normalizeTenantRole(role: string | null | undefined): TenantRole | null {
  const normalized = String(role || "").toLowerCase();
  return ["owner", "admin", "manager", "clerk"].includes(normalized) ? (normalized as TenantRole) : null;
}

export function canAccessSettingsUsers(actor: { role: string } | null) {
  const actorRole = normalizeTenantRole(actor?.role);
  return actorRole === "owner" || actorRole === "admin" || actorRole === "manager";
}

export function canAssignSettingsUserRole(actor: { role: string } | null, targetRole: string | null | undefined) {
  const actorRole = normalizeTenantRole(actor?.role);
  const normalizedTargetRole = normalizeTenantRole(targetRole);
  if (!actorRole || !normalizedTargetRole) return false;

  return (
    actorRole === "owner" ||
    (actorRole === "admin" && ["manager", "clerk"].includes(normalizedTargetRole)) ||
    (actorRole === "manager" && normalizedTargetRole === "clerk")
  );
}

export function canAccessSettingsUser(
  actor: { role: string } | null,
  actorUserId: string | null | undefined,
  target: { role: string; user_id: string } | null
) {
  const actorRole = normalizeTenantRole(actor?.role);
  const targetRole = normalizeTenantRole(target?.role);
  const targetUserId = String(target?.user_id || "");
  const actorId = String(actorUserId || "");
  if (!actorRole || !targetRole || !targetUserId || !actorId) return false;

  if (actorRole === "owner") return true;
  if (targetUserId === actorId) return false;
  if (actorRole === "admin") return ["manager", "clerk"].includes(targetRole);
  if (actorRole === "manager") return targetRole === "clerk";
  return false;
}

export function canManageEmployeeSchedules(actor: { role: string; can_settings?: boolean; can_timekeeping?: boolean } | null) {
  if (!actor) return false;
  return actor.role === "owner" || actor.role === "admin" || actor.role === "manager" || !!actor.can_settings || !!actor.can_timekeeping;
}
