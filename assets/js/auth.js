import { api } from '/assets/js/api.js';

// Return the server's reason on 401 so the router can diagnose (no guessing)
export async function ensureSession() {
  try {
    return await api('/api/auth/session');
  } catch (e) {
    const reason = (e && e.data && e.data.reason) ? e.data.reason : 'unknown';
    return { user: null, memberships: [], reason, status: e?.status || 0 };
  }
}

// Poll for a very short time to avoid a race right after login cookie is set.
// Default: up to 1.5s total.
export async function waitForSession(timeoutMs = 1500) {
    const start = Date.now();
    let session = await ensureSession();
    while (!session?.user && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 150));
      session = await ensureSession();
    }
    return session;
}
