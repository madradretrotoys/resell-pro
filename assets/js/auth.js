import { api } from '/assets/js/api.js';

// Ask the server; if it's a 401, pass through the reason so the router can diagnose
export async function ensureSession() {
  try {
    return await api('/api/auth/session');
  } catch (e) {
    const reason = (e && e.data && e.data.reason) ? e.data.reason : 'unknown';
    return { user: null, memberships: [], reason, status: e?.status || 0 };
  }
}

// Small helper to avoid a race right after Set-Cookie (wait up to ~1.5s)
export async function waitForSession(timeoutMs = 1500) {
  const start = Date.now();
  let session = await ensureSession();
  while (!session?.user && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 150));
    session = await ensureSession();
  }
  return session;
}
