import { ensureSession, waitForSession } from '/assets/js/auth.js';
import { showToast } from '/assets/js/ui.js';

const SCREENS = {
  dashboard: { html: '/screens/dashboard.html', js: '/screens/dashboard.js', title: 'Dashboard' },
  pos:       { html: '/screens/pos.html',       js: '/screens/pos.js',       title: 'POS' },
  // NEW: Cash Drawer screen (Phase 1)
  drawer:    { html: '/screens/drawer.html',    js: '/screens/drawer.js',    title: 'Cash Drawer' },
  inventory: { html: '/screens/inventory.html', js: '/screens/inventory.js', title: 'Inventory' },
  research:  { html: '/screens/research.html',  js: '/screens/research.js',  title: 'Research' },

  // Settings as a resolver: users list, new, edit
  settings: {
    resolve: () => {
      const url = new URL(location.href);
      const view = url.searchParams.get('view') || 'users';
      if (view === 'user-new')  return { html: '/screens/settings-user-new.html',  js: '/screens/settings-user-new.js',  title: 'Settings — Add User' };
      if (view === 'user-edit') return { html: '/screens/settings-user-edit.html', js: '/screens/settings-user-edit.js', title: 'Settings — Edit User' };
      return { html: '/screens/settings-users.html', js: '/screens/settings-users.js', title: 'Settings — Users' };
    }
  },
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
  // Support resolvers (e.g., settings sub-screens)
  const entry = typeof SCREENS[name]?.resolve === 'function'
    ? SCREENS[name].resolve()
    : SCREENS[name] || SCREENS.dashboard;

  const view = document.getElementById('app-view');
  if(!view) throw new Error('#app-view not found');

  // ...
  try {
    view.innerHTML = await loadHTML(entry.html + `?v=${Date.now()}`);
  } catch (e) { /* ...unchanged... */ }

  try {
    const mod = await import(entry.js + `?v=${Date.now()}`);
    // prefer default.load, keep init for backward-compat
    if(mod?.default?.load) await mod.default.load({ container:view, session });
    if(mod?.init)           await mod.init({ container:view, session });
    current = { name, mod };
  } catch (e) { /* ...unchanged... */ }

  document.title = `Resell Pro — ${entry.title}`;
  setActiveLink(name);
}
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
