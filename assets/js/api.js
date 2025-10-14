let ACTIVE_TENANT_ID = null;

// Optional: expose for other modules that need to switch tenants explicitly
export function setActiveTenant(id) {
  ACTIVE_TENANT_ID = id || null;
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
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;

  // Only set JSON content-type for plain objects (NOT for FormData)
  if (!headers.has("content-type") && opts.body && typeof opts.body === "object" && !isForm)
    headers.set("content-type", "application/json");
  headers.set("accept", "application/json");

  // Attach tenant explicitly from session
  if (ACTIVE_TENANT_ID) headers.set("x-tenant-id", ACTIVE_TENANT_ID);

  // Pass FormData through; JSON-stringify plain objects; otherwise use as-is
  const requestBody = isForm
    ? opts.body
    : (opts.body && typeof opts.body === "object" ? JSON.stringify(opts.body) : opts.body);

  const resp = await fetch(path, {
    method: opts.method || "GET",
    credentials: "include",
    headers,
    body: requestBody,
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

