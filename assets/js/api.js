let ACTIVE_TENANT_ID = null;

// Bootstrap: keep a global mirror so non-api callers (e.g., multipart upload) can read it,
// and initialize from the global if it was already set elsewhere.
if (typeof window !== "undefined") {
  if (window.ACTIVE_TENANT_ID && !ACTIVE_TENANT_ID) {
    ACTIVE_TENANT_ID = String(window.ACTIVE_TENANT_ID).trim() || null;
  } else if (ACTIVE_TENANT_ID && !window.ACTIVE_TENANT_ID) {
    window.ACTIVE_TENANT_ID = ACTIVE_TENANT_ID;
  }
}

// Optional: expose for other modules that need to switch tenants explicitly
export function setActiveTenant(id) {
  ACTIVE_TENANT_ID = id ? String(id).trim() : null;
  if (typeof window !== "undefined") window.ACTIVE_TENANT_ID = ACTIVE_TENANT_ID;
}

// getCookie helper (kept for other uses if you need it)
function getCookie(name) {
  const safe = name.replace(/([.[\]$?*|{}()\\/+^])/g, "\\$1");
  const re = new RegExp("(?:^|; )" + safe + "=([^;]*)");
  const matches = document.cookie.match(re);
  return matches ? decodeURIComponent(matches[1]) : undefined;
}

export async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (!headers.has("content-type") && opts.body && typeof opts.body === "object")
    headers.set("content-type", "application/json");
  headers.set("accept", "application/json");

  // Ensure module/global mirrors are in sync before using them
  if (!ACTIVE_TENANT_ID && typeof window !== "undefined" && window.ACTIVE_TENANT_ID) {
    ACTIVE_TENANT_ID = String(window.ACTIVE_TENANT_ID).trim() || null;
  }
  if (typeof window !== "undefined" && ACTIVE_TENANT_ID && window.ACTIVE_TENANT_ID !== ACTIVE_TENANT_ID) {
    window.ACTIVE_TENANT_ID = ACTIVE_TENANT_ID;
  }

  // Attach tenant explicitly from session
  if (ACTIVE_TENANT_ID) headers.set("x-tenant-id", ACTIVE_TENANT_ID);


  const resp = await fetch(path, {
    method: opts.method || "GET",
    credentials: "include",
    headers,
    body:
      opts.body && typeof opts.body === "object" ? JSON.stringify(opts.body) : opts.body,
    cache: "no-store",
  });

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!resp.ok)
    throw Object.assign(new Error("API error"), { status: resp.status, data });
  return data;
}
