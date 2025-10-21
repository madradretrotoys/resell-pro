//begin auth.js
import { api, setActiveTenant } from '/assets/js/api.js';

function log(...args){ try{ console.log('[auth]', ...args); }catch{} }

// Ask the server; if it's a 401, pass through the reason so the router can diagnose
export async function ensureSession() {
  log('ensureSession:begin', { time: new Date().toISOString(), location: location.href });
  try {
    const data = await api('/api/auth/session');
    // NEW: propagate active tenant to api.js so all future calls carry x-tenant-id
    if (data && 'active_tenant_id' in data) setActiveTenant(data.active_tenant_id || null);

    log('ensureSession:ok', { user: !!data?.user, debug: data?.debug });
    return data;
  } catch (e) {
    const reason = (e && e.data && e.data.reason) ? e.data.reason : 'unknown';
    log('ensureSession:401', { status: e?.status, reason, debug: e?.data?.debug });
    return { user: null, memberships: [], reason, status: e?.status || 0, debug: e?.data?.debug };
  }
}

// Small helper to avoid a race right after Set-Cookie (wait up to ~1.5s)
export async function waitForSession(timeoutMs = 1500) {
  log('waitForSession:start', { timeoutMs });
  const start = Date.now();
  let session = await ensureSession();
  while (!session?.user && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 150));
    log('waitForSession:retry');
    session = await ensureSession();
  }
  log('waitForSession:end', { authenticated: !!session?.user, reason: session?.reason, debug: session?.debug });
  return session;
}
//end auth.js file
