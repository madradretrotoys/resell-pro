import { neon } from '@neondatabase/serverless';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, any>> {
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
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error('bad_sig');

  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error('expired');
  return payload;
}

function sanitizeLoginPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function suggestUniqueLoginId(sql: ReturnType<typeof neon>, firstName: string, middleInitial: string, lastName: string) {
  const first = sanitizeLoginPart(firstName);
  const middle = sanitizeLoginPart(middleInitial).charAt(0);
  const last = sanitizeLoginPart(lastName);
  const fi = first.charAt(0);

  const baseCandidates = [
    `${fi}${middle}${last}`,
    `${fi}${last}`,
    `${first}${last}`,
    `${last}${fi}`,
  ].map((v) => v.replace(/[^a-z0-9]/g, '')).filter(Boolean);

  const uniqueBases = [...new Set(baseCandidates.length ? baseCandidates : ['user'])];

  for (const base of uniqueBases) {
    for (let digits = 1; digits <= 4; digits += 1) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const min = 10 ** (digits - 1);
        const max = 10 ** digits - 1;
        const num = Math.floor(Math.random() * (max - min + 1)) + min;
        const candidate = `${base}${String(num).padStart(digits, '0')}`;
        const rows = await sql<{ exists: number }[]>`SELECT 1 AS exists FROM app.users WHERE lower(login_id)=lower(${candidate}) LIMIT 1`;
        if (rows.length === 0) return candidate;
      }
    }
  }

  return `${uniqueBases[0]}${Math.floor(Math.random() * 9000 + 1000)}`;
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const cookieHeader = request.headers.get('cookie') || '';
    const token = readCookie(cookieHeader, '__Host-rp_session');
    if (!token) return json({ ok: false, error: 'no_cookie' }, 401);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || '');
    if (!actor_user_id) return json({ ok: false, error: 'bad_token' }, 401);

    const tenant_id = request.headers.get('x-tenant-id');
    if (!tenant_id) return json({ ok: false, error: 'missing_tenant' }, 400);

    const sql = neon(String(env.DATABASE_URL));

    const actor = await sql<
      { role: 'owner' | 'admin' | 'manager' | 'clerk'; active: boolean; can_settings: boolean | null }[]
    >`
      SELECT m.role, m.active, COALESCE(p.can_settings, false) AS can_settings
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;

    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: 'forbidden' }, 403);

    const role = actor[0].role;
    const allowSettings = role === 'owner' || role === 'admin' || role === 'manager' || !!actor[0].can_settings;
    if (!allowSettings) return json({ ok: false, error: 'forbidden' }, 403);

    const permissionColumns = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'permissions'
        AND data_type = 'boolean'
      ORDER BY ordinal_position
    `;

    const cols = permissionColumns
      .map((r) => r.column_name)
      .filter((col) => /^[a-z_][a-z0-9_]*$/i.test(col));

    const url = new URL(request.url);
    const first = String(url.searchParams.get('first_name') || '').trim();
    const middle = String(url.searchParams.get('middle_initial') || '').trim();
    const last = String(url.searchParams.get('last_name') || '').trim();

    let suggested_login_id: string | null = null;
    if (first && last) {
      suggested_login_id = await suggestUniqueLoginId(sql, first, middle, last);
    }

    return json({ ok: true, permission_columns: cols, suggested_login_id });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
