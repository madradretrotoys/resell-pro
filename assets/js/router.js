import { ensureSession, waitForSession } from '/assets/js/auth.js';
import { showToast } from '/assets/js/ui.js';
import '/assets/js/api.js'; // ensure window.api is available to screens
const SCREENS = {
  dashboard: { html: '/screens/dashboard.html', js: '/screens/dashboard.js', title: 'Dashboard' },
  pos:       { html: '/screens/pos.html',       js: '/screens/pos.js',       title: 'POS' },
  // NEW: Cash Drawer
  drawer:    { html: '/screens/drawer.html',    js: '/screens/drawer.js',    title: 'Cash Drawer' },
  inventory: { html: '/screens/inventory.html', js: '/screens/inventory.js', title: 'Inventory' },
  intake: { html: '/screens/inventory-intake.html', js: '/screens/inventory-intake.js', title: 'Inventory Intake' },
  research:  { html: '/screens/research.html',  js: '/screens/research.js',  title: 'Research' },

  // Settings landing (chooser)
  settings: {
    html: '/screens/settings-landing.html',
    js:   '/screens/settings-landing.js',
    title: 'Settings',
  },

  // Settings → Users (moved from 'settings')
  'settings-users': {
    html: '/screens/settings-users.html',
    js:   '/screens/settings-users.js',
    title: 'Settings · Users',
  },
  'settings-user-new': {
    html: '/screens/settings-user-new.html',
    js:   '/screens/settings-user-new.js',
    title: 'Settings · Add User',
  },
  'settings-user-edit': {
    html: '/screens/settings-user-edit.html',
    js:   '/screens/settings-user-edit.js',
    title: 'Settings · Edit User',
  },

  // Settings → Marketplaces (new)
  'settings-marketplaces': {
    html: '/screens/settings-marketplaces.html',
    js:   '/screens/settings-marketplaces.js',
    title: 'Settings · Marketplaces',
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
  const meta = SCREENS[name] || SCREENS.dashboard;
  // Defensive: pick the last #app-view in case multiple exist
  const candidates = Array.from(document.querySelectorAll('#app-view'));
  const view = candidates[candidates.length - 1] || document.getElementById('app-view');
  if(!view) throw new Error('#app-view not found');

  log('loadScreen:start', { name, href: location.href, cookie: document.cookie });

  // 1) Check session (handles tiny race right after login)
  let session = await ensureSession();
  if (!session?.user) session = await waitForSession(1500);
  if (!session?.user) {
    log('auth:fail->redirect', { reason: session?.reason, status: session?.status, debug: session?.debug });
    location.href = '/index.html';
    return;
  }
  log('auth:ok', { user: session.user });

  // 2) Swap screen
  if(current.mod?.destroy) { try { current.mod.destroy(); } catch(e){ log('destroy:error', e); } }
  view.innerHTML = 'Loading…';
  try {
    view.innerHTML = await loadHTML(meta.html + `?v=${Date.now()}`);
  } catch (e) {
    log('screen:html:error', e);
    view.innerHTML = `\nFailed to load screen.\n`;
    return;
  }
  try {
    const mod = await import(meta.js + `?v=${Date.now()}`);
    if(mod?.init) await mod.init({ container:view, session });
    current = { name, mod };
    log('screen:script:ok', { name });
  } catch (e) {
    log('screen:script:error', e);
    showToast('Screen script error');
  }
  document.title = `Resell Pro — ${meta.title}`;
setActiveLink(name);

// Ensure menus are closed AFTER the new screen is painted and any CSS transitions settle
requestAnimationFrame(() => {
  closeMenus();
  // additional passes for slow mobile paints / transitions
  setTimeout(closeMenus, 120);
  setTimeout(closeMenus, 360);
});

// Release nav lock (see below)
window.__navLock = false;

  log('loadScreen:end', { name });
  
  // Mobile-only fallback: if flagged, do a one-time hard reload after paint
  if (window.__forceMobileReloadOnce) {
    // clear the flag to avoid loops
    window.__forceMobileReloadOnce = false;
    // Allow the DOM to present the new screen, then replace to refresh
    requestAnimationFrame(() => {
      setTimeout(() => {
        try { closeMenus(); } catch {}
        location.replace(location.href);
      }, 0);
    });
  }
  
}


async function goto(name){
  // Prevent double navigation on touchend+click
  if (window.__navLock) return;
  window.__navLock = true;

  const u = new URL(location.href);
  u.searchParams.set('page', name);
  history.pushState({}, '', u);

  // Close immediately before loading
  closeMenus();
  // small delay to catch CSS-driven drawers
  setTimeout(closeMenus, 60);

  // Hint: on mobile, do a one-time hard refresh after the new screen paints
  // to defeat stubborn menu/focus states in certain browsers.
  window.__forceMobileReloadOnce = /Mobi|Android/i.test(navigator.userAgent);

  await loadScreen(name);

  // Extra pass after the screen init settles
  requestAnimationFrame(() => {
    closeMenus();
    setTimeout(closeMenus, 120);
  });
}

window.addEventListener('popstate', () => loadScreen(qs('page') || 'dashboard'));
// Mobile: some browsers fire touchend without a subsequent click
document.addEventListener('touchend', (e) => {
  const a = e.target.closest('[data-page]');
  if (!a) return;
  if (e.cancelable) e.preventDefault();
  closeMenus();
  goto(a.getAttribute('data-page'));
}, { passive: false });

// If the tab becomes visible again or the viewport changes, ensure menus are shut
document.addEventListener('visibilitychange', () => { if (!document.hidden) closeMenus(); });
window.addEventListener('resize', () => closeMenus());

// Defensive: if a page is restored from bfcache/pageshow, close menus
window.addEventListener('pageshow', () => setTimeout(closeMenus, 0));

function closeMenus(){
  // 0) Clear :target-based menus and active focus that can keep overlays shown
  try {
    if (location.hash) {
      const noHash = location.pathname + location.search;
      history.replaceState({}, '', noHash);
    }
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  } catch {}

  // 1) Checkbox toggles (multiple, if any) — also dispatch 'change' so CSS/listeners react
  const toggles = [
    document.getElementById('navcheck'),
    ...document.querySelectorAll('input[type="checkbox"][data-menu-toggle], input[type="checkbox"][id*="nav"]')
  ].filter(Boolean);

  toggles.forEach(cb => {
    try {
      if (cb.checked) cb.checked = false;
      cb.blur?.();
      cb.dispatchEvent?.(new Event('change', { bubbles: true }));
    } catch {}
  });

  // 2) <details> patterns
  document.querySelectorAll('details[open]').forEach(d => d.removeAttribute('open'));

  // 3) aria-expanded patterns
  document.querySelectorAll('[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));

  // 4) Common containers/classes (include the actual drawer: #nav)
const containers = [
  document.getElementById('nav'),
  document.getElementById('app-menu'),
  ...document.querySelectorAll('[data-menu], .menu, .mobile-nav, .nav-drawer, .drawer')
];
containers.forEach(el => {
  ['open','active','show','visible','is-open','drawer-open'].forEach(cls => el?.classList?.remove(cls));
  if (el && el.style) {
    el.style.pointerEvents = '';
    el.style.display = '';
    el.style.visibility = '';
  }
});

  // 5) Body state
  document.body.classList.remove('menu-open');
}

log('boot');
loadScreen(qs('page') || 'dashboard');
