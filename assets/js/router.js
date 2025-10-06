// Router — baseline, stable version (no resolver logic)
import { ensureSession, waitForSession } from '/assets/js/auth.js';
import { showToast } from '/assets/js/ui.js';

// Simple one-route-per-screen map.
// NOTE: 'settings' temporarily points to dashboard to keep the app stable.
const SCREENS = {
  dashboard: { html: '/screens/dashboard.html', js: '/screens/dashboard.js', title: 'Dashboard' },
  pos:       { html: '/screens/pos.html',       js: '/screens/pos.js',       title: 'POS' },
  drawer:    { html: '/screens/drawer.html',    js: '/screens/drawer.js',    title: 'Cash Drawer' },
  inventory: { html: '/screens/inventory.html', js: '/screens/inventory.js', title: 'Inventory' },
  research:  { html: '/screens/research.html',  js: '/screens/research.js',  title: 'Research' },

  // TEMP: keep Settings link harmless until we reintroduce sub-screens
  settings:  { html: '/screens/dashboard.html', js: '/screens/dashboard.js', title: 'Dashboard' },
};

let current = { name: null, mod: null };
const qs = (k) => new URLSearchParams(location.search).get(k);

function log(...args){ try{ console.log('[router]', ...args); }catch{} }

function setActiveLink(name){
  document.querySelectorAll('[data-page]').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-page') === name);
  });
}

async function loadHTML(url){
  log('loadHTML:begin', url);
  const r = await fetch(url, { credentials:'include' });
  log('loadHTML:resp', { ok: r.ok, status: r.status });
  if(!r.ok) throw new Error(url);
  const text = await r.text();
  log('loadHTML:end', { bytes: text.length });
  return text;
}

export async function loadScreen(name){
  const meta = SCREENS[name] || SCREENS.dashboard;
  const view = document.getElementById('app-view');
  if(!view) throw new Error('#app-view not found');

  log('loadScreen:start', { name, href: location.href });

  // Session gate (as before)
  let session = await ensureSession();
  if (!session?.user) session = await waitForSession(1500);
  if (!session?.user) {
    log('auth:fail->redirect', { reason: session?.reason, status: session?.status });
    location.href = '/index.html';
    return;
  }
  log('auth:ok', { user: session.user });

  // Unmount previous
  if(current.mod?.destroy) {
    try { current.mod.destroy(); } catch(e){ log('destroy:error', e); }
  }

  // Load HTML
  view.innerHTML = 'Loading…';
  try {
    view.innerHTML = await loadHTML(meta.html + `?v=${Date.now()}`);
  } catch (e) {
    log('screen:html:error', e);
    view.innerHTML = `Failed to load screen.`;
    return;
  }

  // Load JS module (baseline: call init if present)
  try {
    const mod = await import(meta.js + `?v=${Date.now()}`);
    if (mod?.init) await mod.init({ container:view, session });
    current = { name, mod };
    log('screen:script:ok', { name });
  } catch (e) {
    log('screen:script:error', e);
    showToast('Screen script error');
  }

  document.title = `Resell Pro — ${meta.title}`;
  setActiveLink(name);
  log('loadScreen:end', { name });
}

// Navigation wiring (unchanged)
function goto(name){
  const u = new URL(location.href);
  u.searchParams.set('page', name);
  history.pushState({}, '', u);
  loadScreen(name);
}

window.addEventListener('popstate', () => loadScreen(qs('page') || 'dashboard'));

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-page]');
  if(!a) return;
  e.preventDefault();
  goto(a.getAttribute('data-page'));
});

log('boot');
loadScreen(qs('page') || 'dashboard');
