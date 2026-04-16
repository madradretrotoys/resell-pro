import { neon } from '@neondatabase/serverless';

type Sql = ReturnType<typeof neon>;

export const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, any>> {
  const enc = new TextEncoder();
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('bad_token');

  const base64urlToBytes = (str: string) => {
    const pad = '='.repeat((4 - (str.length % 4)) % 4);
    const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };

  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify('HMAC', key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error('bad_sig');

  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error('expired');
  return payload as Record<string, any>;
}

export async function requireTimesheetActor(request: Request, env: any, sql: Sql) {
  const cookieHeader = request.headers.get('cookie') || '';
  const token = readCookie(cookieHeader, '__Host-rp_session');
  if (!token) return { error: json({ ok: false, error: 'no_cookie' }, 401) };

  const payload = await verifyJwt(token, String(env.JWT_SECRET));
  const actor_user_id = String((payload as any).sub || '');
  if (!actor_user_id) return { error: json({ ok: false, error: 'bad_token' }, 401) };

  const tenant_id = request.headers.get('x-tenant-id');
  if (!tenant_id) return { error: json({ ok: false, error: 'missing_tenant' }, 400) };

  const rows = await sql<{
    role: string;
    active: boolean;
    can_timekeeping: boolean;
    can_edit_timesheet: boolean;
    login_id: string;
    name: string;
  }[]>`
    SELECT
      m.role,
      m.active,
      COALESCE(p.can_timekeeping, false) AS can_timekeeping,
      COALESCE(p.can_edit_timesheet, false) AS can_edit_timesheet,
      u.login_id,
      u.name
    FROM app.memberships m
    JOIN app.users u ON u.user_id = m.user_id
    LEFT JOIN app.permissions p ON p.user_id = m.user_id
    WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
    LIMIT 1
  `;

  if (!rows.length || rows[0].active === false) return { error: json({ ok: false, error: 'forbidden' }, 403) };
  if (!rows[0].can_timekeeping) return { error: json({ ok: false, error: 'timesheet_denied' }, 403) };

  return {
    actor: {
      actor_user_id,
      tenant_id,
      role: rows[0].role,
      can_timekeeping: rows[0].can_timekeeping,
      can_edit_timesheet: rows[0].can_edit_timesheet,
      login_id: rows[0].login_id,
      name: rows[0].name,
    },
  };
}

export function toIsoOrNull(v: any): string | null {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function dayBounds(dateStr?: string) {
  const d = dateStr ? new Date(`${dateStr}T00:00:00.000Z`) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const base = `${y}-${m}-${day}`;
  return {
    date: base,
    startIso: `${base}T00:00:00.000Z`,
    endIso: `${base}T23:59:59.999Z`,
  };
}

export function makeEntryId() {
  return `te_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function calcTotalHours(clockIn: any, lunchOut: any, lunchIn: any, clockOut: any): number | null {
  if (!clockIn || !clockOut) return null;
  const startMs = new Date(clockIn).getTime();
  const endMs = new Date(clockOut).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null;

  let workedMs = endMs - startMs;

  if (lunchOut && lunchIn) {
    const lunchOutMs = new Date(lunchOut).getTime();
    const lunchInMs = new Date(lunchIn).getTime();
    if (!Number.isNaN(lunchOutMs) && !Number.isNaN(lunchInMs) && lunchInMs > lunchOutMs) {
      workedMs -= (lunchInMs - lunchOutMs);
    }
  }

  const hours = workedMs / 3600000;
  if (hours < 0) return null;
  return Math.round(hours * 100) / 100;
}
