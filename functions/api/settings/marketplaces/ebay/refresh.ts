// functions/api/marketplaces/ebay/refresh.ts
// Refreshes the eBay access token using the stored refresh token and same scope family.

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Same policy & tenant header as other endpoints
  const tenantId = request.headers.get("x-tenant-id");
  if (!tenantId) return json(400, { error: "missing_tenant" });

  const body = await safeJson(request);
  const marketplaceId = (body?.marketplace_id ?? "ebay") as string;

  // Load secrets and tokens
  const row = await selectSecrets(env, tenantId, marketplaceId);
  if (!row) return json(404, { error: "not_connected" });

  const encKey = env.RP_ENCRYPTION_KEY || "";
  const secrets = await decryptJson(encKey, row.secrets_blob);
  const refreshProtected = row.refresh_token as string | null;

  const refreshJson = refreshProtected ? await decryptJson(encKey, refreshProtected) : null;
  const refreshToken = refreshJson?.v as string | undefined;

  if (!secrets || !refreshToken) {
    await updateStatus(env, tenantId, marketplaceId, "error", "missing_refresh_token");
    return json(400, { error: "missing_refresh_token" });
  }

  const environment = secrets.environment as "sandbox" | "production";
  const tokenHost = environment === "production"
    ? "https://api.ebay.com/identity/v1/oauth2/token"
    : "https://api.sandbox.ebay.com/identity/v1/oauth2/token";

  const basic = btoa(`${secrets.client_id}:${secrets.client_secret}`);
  const scopes = [
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  ];

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });

  const res = await fetch(tokenHost, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "authorization": `Basic ${basic}`,
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    await updateStatus(env, tenantId, marketplaceId, "error", `refresh_failed: ${txt.slice(0, 500)}`);
    return json(502, { error: "refresh_failed" });
  }

  const jsonRes = await res.json() as { access_token: string; expires_in: number; };
  const tokenExpiresAt = new Date(Date.now() + Math.max(0, (jsonRes.expires_in - 60)) * 1000).toISOString();

  await persistAccess(env, {
    tenantId,
    marketplaceId,
    access_token: await protect(encKey, jsonRes.access_token),
    token_expires_at: tokenExpiresAt,
  });

  await updateStatus(env, tenantId, marketplaceId, "connected", "refreshed_ok");
  return json(200, { ok: true, token_expires_at: tokenExpiresAt });
};

// ---------- Helpers ----------
type Env = {
  RP_ENCRYPTION_KEY?: string;
  DATABASE_URL?: string;
};

async function selectSecrets(env: Env, tenantId: string, marketplaceId: string) {
  const sql = `
    SELECT secrets_blob, refresh_token
    FROM app.marketplace_connections
    WHERE tenant_id=$1 AND marketplace_id=$2
  `;
  const rows = await querySql(env, sql, [tenantId, marketplaceId]);
  return rows[0] || null;
}

async function persistAccess(env: Env, args: { tenantId: string; marketplaceId: string; access_token: string; token_expires_at: string; }) {
  const sql = `
    UPDATE app.marketplace_connections
    SET access_token=$3, token_expires_at=$4, last_success_at=now(), updated_at=now()
    WHERE tenant_id=$1 AND marketplace_id=$2
  `;
  await execSql(env, sql, [args.tenantId, args.marketplaceId, args.access_token, args.token_expires_at]);
}

async function updateStatus(env: Env, tenantId: string, marketplaceId: string, status: string, reason?: string) {
  const sql = `UPDATE app.marketplace_connections SET status=$3, status_reason=$4, updated_at=now() WHERE tenant_id=$1 AND marketplace_id=$2`;
  await execSql(env, sql, [tenantId, marketplaceId, status, reason || null]);
}

async function protect(base64Key: string, value: string) {
  return encryptJson(base64Key, { v: value });
}

async function encryptJson(base64Key: string, obj: unknown): Promise<string> {
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  if (!base64Key) return b64(plaintext);
  const key = await crypto.subtle.importKey("raw", b64d(base64Key), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return b64(iv) + "." + b64(ct);
}

async function decryptJson(base64Key: string, blob: string): Promise<any> {
  if (!blob) return null;
  const [ivB64, ctB64] = blob.split(".");
  const iv = b64d(ivB64);
  const ct = b64d(ctB64);
  if (!base64Key) return JSON.parse(new TextDecoder().decode(ct));
  const key = await crypto.subtle.importKey("raw", b64d(base64Key), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function safeJson(request: Request) { try { return await request.json(); } catch { return null; } }
function b64(u8: Uint8Array) { return btoa(String.fromCharCode(...u8)); }
function b64d(s: string) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

// DB stubs – replace with your shared Neon helper
async function execSql(env: Env, sql: string, params: unknown[]) { /* see note */ }
async function querySql(env: Env, sql: string, params: unknown[]) { /* see note */ return []; }
