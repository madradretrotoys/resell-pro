import { ensureSession, waitForSession } from '/assets/js/auth.js';
import { showToast } from '/assets/js/ui.js';

const SCREENS = {
  dashboard: { html: '/screens/dashboard.html', js: '/screens/dashboard.js', title: 'Dashboard' },
  pos:        { html: '/screens/pos.html',        js: '/screens/pos.js',        title: 'POS' },
  inventory:  { html: '/screens/inventory.html',  js: '/screens/inventory.js',  title: 'Inventory' },
  research:   { html: '/screens/research.html',   js: '/screens/research.js',   title: 'Research' },
};

let current = { name: null, mod: null };
const qs = (k) => new URLSearchParams(location.search).get(k);

function setActiveLink(name){
  document.querySelectorAll('[data-page]').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-page') === name);
  });
}

async function loadHTML(url){
  const r = await fetch(url, { credentials:'include' });
  if(!r.ok) throw new Error(url);
  return r.text();
}

export async function loadScreen(name){
  const meta = SCREENS[name] || SCREENS.dashboard;
  const view = document.getElementById('app-view');
  if(!view) throw new Error('#app-view not found');

  // 1) Check session (handles tiny race right after login)
  let session = await ensureSession();
  if (!session?.user) {
    session = await waitForSession(1500);
  }
  if (!session?.user) {
    console.warn('Auth check failed; redirecting.', { reason: session?.reason, status: session?.status });
    location.href = '/index.html';
    return;
  }

  // 2) Swap screen
  if(current.mod?.destroy) {
    try { current.mod.destroy(); } catch {}
  }
  view.innerHTML = 'Loading…';

  try {
    view.innerHTML = await loadHTML(meta.html + `?v=${Date.now()}`);
  } catch (e) {
    view.innerHTML = `\nFailed to load screen.\n`;
    return;
  }

  try {
    const mod = await import(meta.js + `?v=${Date.now()}`);
    if(mod?.init) await mod.init({ container:view, session });
    current = { name, mod };
  } catch (e) {
    console.error(e);
    showToast('Screen script error');
  }

  document.title = `Resell Pro — ${meta.title}`;
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

loadScreen(qs('page') || 'dashboard');
