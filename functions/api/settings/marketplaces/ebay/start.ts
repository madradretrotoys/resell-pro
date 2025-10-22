// Begin functions/api/settings/marketplaces/ebay/start.ts
// POST: returns { redirect_url } to eBay's consent page, using Sandbox (default) or Production env.
export const onRequestPost: PagesFunction = async (context) => {
  const { request, env } = context;

  const tenantId = request.headers.get("x-tenant-id");
  if (!tenantId) return json(400, { error: "missing_tenant" });

  const body = await safeJson(request);
  const marketplaceId = (body?.marketplace_id ?? "ebay") as string;
  const environment = (body?.environment ?? "sandbox") as "sandbox" | "production";

  // Load credentials (BYO or platform)
  const runame = environment === "production" ? env.EBAY_PROD_RUNAME : env.EBAY_SANDBOX_RUNAME;
  const clientId = environment === "production" ? env.EBAY_PROD_CLIENT_ID : env.EBAY_SANDBOX_CLIENT_ID;
  const clientSecret = environment === "production" ? env.EBAY_PROD_CLIENT_SECRET : env.EBAY_SANDBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret || !runame) {
    return json(400, { error: "missing_credentials" });
  }

  // Upsert connection row as 'auth_initiated' (optional for v1)
  // await upsertConnection(...)

  // Build signed state (stateless CSRF + tenancy context)
  const state = await signState(env, {
    tenantId,
    marketplaceId,
    environment,
    ts: Date.now(),
  });

  const scopes = [
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  ];

  const authBase = environment === "production"
    ? "https://auth.ebay.com/oauth2/authorize"
    : "https://auth.sandbox.ebay.com/oauth2/authorize";

  // eBay requires the RuName as redirect_uri
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: runame,
    response_type: "code",
    scope: scopes.join(" "),
    state,
  });

  const redirect_url = `${authBase}?${q.toString()}`;
  return json(200, { redirect_url });
};

// --- helpers (minimal versions to keep the file self-contained) ---
function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
async function safeJson(request: Request) { try { return await request.json(); } catch { return null; } }
function b64(u8: Uint8Array) { return btoa(String.fromCharCode(...u8)); }
function b64d(s: string) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function signState(env: any, payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const secretBytes = env.RP_STATE_SECRET ? b64d(env.RP_STATE_SECRET) : new TextEncoder().encode("dev-secret");
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return btoa(raw) + "." + b64(mac);
}

//end start.ts
