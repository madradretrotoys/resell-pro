// functions/api/marketplaces/ebay/callback.ts
// Handles eBay redirect back to our app. Exchanges code → tokens, saves to DB, and redirects to the app screen.

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return html(400, "Missing code/state");
  }

  // Validate state (HMAC-signed, stateless)
  const parsed = await verifyState(env, state);
  if (!parsed) {
    return html(400, "Invalid state");
  }
  const tenantId = parsed.tenantId as string;
  const marketplaceId = (parsed.marketplaceId as string) || "ebay";
  const environment = (parsed.environment as "sandbox" | "production") || "sandbox";

  // Load secrets to know which client credentials to use (BYO or platform)
  const { clientId, clientSecret, runame } = await loadClientCreds(env, tenantId, marketplaceId, environment);
  if (!clientId || !clientSecret || !runame) {
    await updateStatus(env, tenantId, marketplaceId, "error", "missing_client_credentials");
    return html(400, "Missing client credentials");
  }

  // Exchange the code for tokens
  const tokenHost = environment === "production"
    ? "https://api.ebay.com/identity/v1/oauth2/token"
    : "https://api.sandbox.ebay.com/identity/v1/oauth2/token";

  const basic = btoa(`${clientId}:${clientSecret}`);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: runame, // eBay requires RuName here
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
    await updateStatus(env, tenantId, marketplaceId, "error", `exchange_failed: ${txt.slice(0, 500)}`);
    return html(502, "Token exchange failed");
  }

  const json = await res.json() as {
    access_token: string;
    expires_in: number; // seconds
    refresh_token?: string;
    refresh_token_expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  const now = Date.now();
  const tokenExpiresAt = new Date(now + Math.max(0, (json.expires_in - 60)) * 1000).toISOString();

  const encKey = env.RP_ENCRYPTION_KEY || "";
  const secretsBlob = await encryptJson(encKey, {
    // keep client creds with tokens so refresh endpoint has a single decrypt
    environment,
    client_id: clientId,
    client_secret: clientSecret,
    runame,
    access_token: json.access_token,
    refresh_token: json.refresh_token || null,
    token_expires_at: tokenExpiresAt,
  });

  // Persist tokens and mark connected
  await persistTokens(env, {
    tenantId,
    marketplaceId,
    access_token: await protect(encKey, json.access_token),
    refresh_token: json.refresh_token ? await protect(encKey, json.refresh_token) : null,
    token_expires_at: tokenExpiresAt,
    status: "connected",
    status_reason: "eBay OAuth connected",
    secrets_blob: secretsBlob,
  });

  // Redirect back to Settings → Marketplaces
  const appReturn = appReturnUrl(url); // e.g., /#/settings/marketplaces
  return Response.redirect(appReturn, 302);
};

// ---------- Helpers ----------
type Env = {
  RP_ENCRYPTION_KEY?: string;
  RP_STATE_SECRET?: string;
  DATABASE_URL?: string;
};

function appReturnUrl(current: URL) {
  // Return to your SPA Settings screen; adjust hash route if needed.
  return `${current.origin}/#/settings/marketplaces`;
}

async function loadClientCreds(env: Env, tenantId: string, marketplaceId: string, environment: "sandbox"|"production") {
  // Read the row from app.marketplace_connections and decrypt secrets_blob if present;
  // else fall back to platform ENV.
  const row = await selectConnection(env, tenantId, marketplaceId);
  if (row?.secrets_blob) {
    const data = await decryptJson(env.RP_ENCRYPTION_KEY || "", row.secrets_blob);
    return { clientId: data.client_id, clientSecret: data.client_secret, runame: data.runame };
  }
  // Fallback: platform env
  // You can also import the helper from start.ts if you prefer to DRY it.
  const plat = (environment === "production")
    ? { clientId: (env as any).EBAY_PROD_CLIENT_ID, clientSecret: (env as any).EBAY_PROD_CLIENT_SECRET, runame: (env as any).EBAY_PROD_RUNAME }
    : { clientId: (env as any).EBAY_SANDBOX_CLIENT_ID, clientSecret: (env as any).EBAY_SANDBOX_CLIENT_SECRET, runame: (env as any).EBAY_SANDBOX_RUNAME };
  return plat;
}

async function persistTokens(env: Env, args: {
  tenantId: string;
  marketplaceId: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string;
  status: string;
  status_reason?: string;
  secrets_blob: string;
}) {
  const sql = `
    INSERT INTO app.marketplace_connections
      (tenant_id, marketplace_id, access_token, refresh_token, token_expires_at, status, status_reason, secrets_blob, last_success_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (tenant_id, marketplace_id)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      token_expires_at = EXCLUDED.token_expires_at,
      status = EXCLUDED.status,
      status_reason = EXCLUDED.status_reason,
      secrets_blob = EXCLUDED.secrets_blob,
      last_success_at = now(),
      updated_at = now()
  `;
  await execSql(env, sql, [
    args.tenantId,
    args.marketplaceId,
    args.access_token,
    args.refresh_token,
    args.token_expires_at,
    args.status,
    args.status_reason || null,
    args.secrets_blob,
  ]);
}

async function updateStatus(env: Env, tenantId: string, marketplaceId: string, status: string, reason?: string) {
  const sql = `
    INSERT INTO app.marketplace_connections
      (tenant_id, marketplace_id, status, status_reason)
    VALUES
      ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, marketplace_id)
    DO UPDATE SET
      status = EXCLUDED.status,
      status_reason = EXCLUDED.status_reason,
      updated_at = now()
  `;
  await execSql(env, sql, [tenantId, marketplaceId, status, reason || null]);
}

async function verifyState(env: Env, token: string) {
  try {
    const [rawB64, macB64] = token.split(".");
    const raw = new TextDecoder().decode(b64d(rawB64));
    const secret = env.RP_STATE_SECRET ? b64d(env.RP_STATE_SECRET) : new TextEncoder().encode("dev-secret");
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64d(macB64), new TextEncoder().encode(raw));
    if (!ok) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

async function selectConnection(env: Env, tenantId: string, marketplaceId: string) {
  const sql = `SELECT secrets_blob FROM app.marketplace_connections WHERE tenant_id=$1 AND marketplace_id=$2`;
  const rows = await querySql(env, sql, [tenantId, marketplaceId]);
  return rows[0] || null;
}

async function protect(base64Key: string, value: string) {
  return encryptJson(base64Key, { v: value });
}

function html(status: number, text: string) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function b64(u8: Uint8Array) { return btoa(String.fromCharCode(...u8)); }
function b64d(s: string) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

// Reuse your existing DB client; these stubs keep the patch self-contained.
async function execSql(env: Env, sql: string, params: unknown[]) { /* see note in start.ts */ }
async function querySql(env: Env, sql: string, params: unknown[]) { /* see note in start.ts */ return []; }
