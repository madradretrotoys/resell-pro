import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';

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

async function getAuthedCtx(env: Env, request: Request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const token = readCookie(cookieHeader, '__Host-rp_session');
  if (!token) throw Object.assign(new Error('unauthorized'), { status: 401 });

  const payload = await verifyJwt(token, String(env.JWT_SECRET));
  const actor_user_id = String((payload as any).sub || '');
  if (!actor_user_id) throw Object.assign(new Error('unauthorized'), { status: 401 });

  const tenant_id = request.headers.get('x-tenant-id');
  if (!tenant_id) throw Object.assign(new Error('missing_tenant'), { status: 400 });

  const sql = neon(String(env.DATABASE_URL));

  const actorRows = await sql<{
    user_id: string;
    membership_role: 'owner' | 'admin' | 'manager' | 'clerk';
    active: boolean;
    can_settings: boolean | null;
  }[]>`
    SELECT m.user_id, m.role AS membership_role, m.active, COALESCE(p.can_settings, false) AS can_settings
    FROM app.memberships m
    LEFT JOIN app.permissions p ON p.user_id = m.user_id
    WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
    LIMIT 1
  `;

  if (!actorRows.length || actorRows[0].active === false) {
    throw Object.assign(new Error('forbidden'), { status: 403 });
  }

  return {
    sql,
    session: {
      user_id: actor_user_id,
      tenant_id,
      membership_role: actorRows[0].membership_role,
      permissions: { can_settings: !!actorRows[0].can_settings },
    },
  };
}

function normalizeNamePart(value: unknown) {
  return String(value || '').trim();
}

function sanitizeLoginPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildName(first: string, middleInitial: string, last: string) {
  return [first, middleInitial, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function buildTempPassword(first: string, last: string) {
  const base = `${sanitizeLoginPart(first).charAt(0)}${sanitizeLoginPart(last)}`;
  return `${base || 'user'}001`;
}

async function getPermissionBooleanColumns(sql: ReturnType<typeof neon>) {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'permissions'
      AND data_type = 'boolean'
    ORDER BY ordinal_position
  `;
  return rows
    .map((r) => r.column_name)
    .filter((col) => /^[a-z_][a-z0-9_]*$/i.test(col));
}

async function suggestUniqueLoginId(
  sql: ReturnType<typeof neon>,
  firstName: string,
  middleInitial: string,
  lastName: string
) {
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

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;

  try {
    const { sql, session } = await getAuthedCtx(env, request);
    if (!session.permissions?.can_settings) return json({ ok: false, error: 'forbidden' }, 403);

    const body = await request.json();
    const user_id = String(body.user_id || '').trim() || null;
    const first_name = normalizeNamePart(body.first_name);
    const middle_initial = normalizeNamePart(body.middle_initial).charAt(0).toUpperCase();
    const last_name = normalizeNamePart(body.last_name);
    const emailRaw = normalizeNamePart(body.email).toLowerCase();
    const role = String(body.role || 'clerk').toLowerCase() as 'owner' | 'admin' | 'manager' | 'clerk';

    if (!first_name || !last_name) {
      return json({ ok: false, error: 'first_last_required' }, 400);
    }

    // Role gate
    const actorRole = session.membership_role;
    const allowed = (actorRole === 'owner') ||
      (actorRole === 'admin' && ['manager', 'clerk'].includes(role)) ||
      (actorRole === 'manager' && role === 'clerk');
    if (!allowed) return json({ ok: false, error: 'insufficient_role' }, 403);

    const name = buildName(first_name, middle_initial, last_name);

    let login_id = String(body.login_id || '').trim();
    if (!login_id) {
      login_id = await suggestUniqueLoginId(sql, first_name, middle_initial, last_name);
    }

    const duplicateLogin = await sql<{ user_id: string }[]>`
      SELECT user_id
      FROM app.users
      WHERE lower(login_id) = lower(${login_id})
        AND (${user_id}::uuid IS NULL OR user_id <> ${user_id}::uuid)
      LIMIT 1
    `;
    if (duplicateLogin.length > 0) return json({ ok: false, error: 'login_id_in_use' }, 409);

    const effectiveEmail = emailRaw || `${sanitizeLoginPart(login_id)}@no-email.local`;

    let effectiveUserId = user_id;
    if (!effectiveUserId) {
      const temp_password = buildTempPassword(first_name, last_name);
      const password_hash = await bcrypt.hash(temp_password, 10);

      const created = await sql<{ user_id: string; email: string; login_id: string }[]>`
        INSERT INTO app.users (email, name, login_id, password_hash)
        VALUES (${effectiveEmail}, ${name}, ${login_id}, ${password_hash})
        RETURNING user_id, email, login_id
      `;
      effectiveUserId = created[0]?.user_id || null;
      if (!effectiveUserId) return json({ ok: false, error: 'create_failed' }, 500);
    } else {
      await sql/*sql*/`
        UPDATE app.users
        SET email = ${effectiveEmail},
            name = ${name},
            login_id = ${login_id}
        WHERE user_id = ${effectiveUserId}
      `;
    }

    await sql/*sql*/`
      INSERT INTO app.memberships (tenant_id, user_id, role, active)
      VALUES (${session.tenant_id}, ${effectiveUserId}, ${role}, true)
      ON CONFLICT (tenant_id, user_id)
      DO UPDATE SET role = EXCLUDED.role, active = true
    `;

    const permissionColumns = await getPermissionBooleanColumns(sql);
    const payloadPerms = {
      ...(body.permissions || {}),
      ...(body.notifications || {}),
    } as Record<string, any>;
    const booleanValues = permissionColumns.map((col) => !!payloadPerms[col]);
    const discount_max = (body.discount_max === null || body.discount_max === '' ? null : Number(body.discount_max));

    await sql/*sql*/`
      INSERT INTO app.permissions (user_id, name, email, role, discount_max)
      VALUES (${effectiveUserId}, ${name}, ${effectiveEmail}, ${role}, ${discount_max})
      ON CONFLICT (user_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        role = EXCLUDED.role,
        discount_max = EXCLUDED.discount_max,
        updated_at = now()
    `;

    if (permissionColumns.length > 0) {
      const assignments = permissionColumns.map((col, i) => `${col} = $${i + 1}`).join(', ');
      await sql(
        `UPDATE app.permissions SET ${assignments}, updated_at = now() WHERE user_id = $${permissionColumns.length + 1}`,
        [...booleanValues, effectiveUserId]
      );
    }

    return json({ ok: true, user_id: effectiveUserId, login_id });
  } catch (e: any) {
    if (e?.status) return json({ ok: false, error: e.message || 'error' }, e.status);
    if (String(e?.message || '').toLowerCase().includes('users_email_key')) {
      return json({ ok: false, error: 'email_in_use' }, 409);
    }
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
