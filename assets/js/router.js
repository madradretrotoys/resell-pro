import { ensureSession, waitForSession } from '/assets/js/auth.js';
import { showToast } from '/assets/js/ui.js';
import '/assets/js/api.js'; // ensure window.api is available to screens
// --- Focus / keyboard state ---
let __TYPING = false;
let __LAST_NAV = 0;

function isTextInput(el){
  if(!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
  return false;
}

function keyboardLikelyOpen(){
  try{
    if (window.visualViewport) {
      const ratio = window.visualViewport.height / window.innerHeight;
      return ratio < 0.85; // heuristic
    }
  }catch{}
  return false;
}

// Track when the user is actively editing
document.addEventListener('focusin', (e) => {
  if (isTextInput(e.target)) __TYPING = true;
}, true);
document.addEventListener('focusout', (e) => {
  if (isTextInput(e.target)) __TYPING = false;
}, true);

// Swallow clicks that start on inputs so they don't bubble into any nav handlers
document.addEventListener('click', (e) => {
  if (isTextInput(e.target)) e.stopPropagation();
}, true);

// Avoid automatic scroll restore pop-causing layout jumps on iOS
try { history.scrollRestoration = 'manual'; } catch {}

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
  // Absolute last-ditch guard
  if (__TYPING || isTextInput(document.activeElement) || keyboardLikelyOpen()){
    setTimeout(() => loadScreen(name), 200);
    return;
  }
  const meta = SCREENS[name] || SCREENS.dashboard;
  // Defensive: pick the last #app-view in case multiple exist
  const candidates = Array.from(document.querySelectorAll('#app-view'));
  const view = candidates[candidates.length - 1] || document.getElementById('app-view');
  if(!view) throw new Error('#app-view not found');

  log('loadScreen:start', { name, href: location.href, cookie: document.cookie });

  // 1) Check session (handles tiny race right after login)
  let session = await ensureSession();
  if (!session?.user) session = await waitForSession(1500);
  
  if (!session?.user && (__TYPING || isTextInput(document.activeElement) || keyboardLikelyOpen())) {
    setTimeout(() => loadScreen(name), 300);
    (window as any).__navLock = false;
    return;
  }
  if (!session?.user) {
    location.href = '/index.html';
    (window as any).__navLock = false;
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
    window.__navLock = false;
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


// Release nav lock (see below)
window.__navLock = false;

  log('loadScreen:end', { name });
  
   
}


async function goto(name){
  // Prevent double navigation on touchend+click
  if ((window as any).__navLock) return;

  // No-op if we're already on this screen
  if (current?.name === name) return;

  // Hard block while typing / keyboard open
  if (__TYPING || isTextInput(document.activeElement) || keyboardLikelyOpen()){
    setTimeout(() => goto(name), 250);
    return;
  }

  (window as any).__navLock = true;

  const u = new URL(location.href);
  u.searchParams.set('page', name);
  history.pushState({}, '', u);

  __LAST_NAV = Date.now();
  await safeLoadScreen(name);
  (window as any).__navLock = false;
}



async function safeLoadScreen(name){
  if (__TYPING || isTextInput(document.activeElement) || keyboardLikelyOpen()){
    setTimeout(() => safeLoadScreen(name), 250);
    return;
  }
  await loadScreen(name);
}

window.addEventListener('popstate', () => {
  const name = qs('page') || 'dashboard';

  // Ignore if it’s the same screen (prevents needless DOM swaps while typing)
  if (current?.name === name) return;

  // Debounce very fast popstates (can happen around viewport changes on mobile)
  if (Date.now() - __LAST_NAV < 500) return;

  // Don’t react while typing / keyboard open
  if (__TYPING || isTextInput(document.activeElement) || keyboardLikelyOpen()){
    setTimeout(() => safeLoadScreen(name), 250);
    return;
  }

  safeLoadScreen(name);
});

document.addEventListener('focusin', (e) => {
  if (e.target && (e.target as HTMLElement).tagName) {
    console.log('[trace] focusin', (e.target as HTMLElement).tagName, performance.now());
  }
}, true);
document.addEventListener('blur', (e) => {
  if (e.target && (e.target as HTMLElement).tagName) {
    console.log('[trace] blur', (e.target as HTMLElement).tagName, performance.now());
  }
}, true);
(function(){
  const ps = history.pushState.bind(history);
  history.pushState = function(...args){
    console.log('[trace] pushState', performance.now());
    // @ts-ignore
    return ps(...args);
  };
  window.addEventListener('popstate', () => console.log('[trace] popstate', performance.now()));
})();

log('boot');
safeLoadScreen(qs('page') || 'dashboard');

