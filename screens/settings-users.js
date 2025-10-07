import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';

const els = {};
function $(id) { return document.getElementById(id); }

// Router expects an `init` entrypoint: mod.init({ container, session })
export async function init({ container, session }) {
  // Ensure we have session (router already does, but safe to double-check)
  if (!session?.user) {
    session = await ensureSession();
  }

  // Bind elements (IDs must exist in settings-users.html)
  els.table = $('usersTable');
  const btnInvite = $('btnInvite');
  const btnRefresh = $('btnRefresh');

  if (btnInvite) {
    btnInvite.onclick = () => alert('Email invite will be added in a later phase.');
  }

  // Permission gate handled server-side by /api/settings/users/list.
  // Proceed and show a friendly message only if the API returns 403.

  if (btnRefresh) btnRefresh.onclick = refresh;

  // Initial load
  await refresh();
}

async function refresh() {
  if (!els.table) return;
  els.table.innerHTML = 'Loading…';
  try {
    const data = await api('/api/settings/users/list');
    els.table.innerHTML = renderTable(data.users || []);
  } catch (e) {
    els.table.innerHTML = (e && e.status === 403)
      ? 'Access denied. Ask an owner to grant Settings access.'
      : 'Failed to load users.';
  }
}

function renderTable(users) {
  if (!users.length) return '

No users yet.
';
  const rows = users.map(u => `
    ${escapeHtml(u.name)}
    ${escapeHtml(u.email)}
    ${escapeHtml(u.login_id)}
    ${escapeHtml(u.role)}
    ${u.active ? 'Yes' : 'No'}
    Edit
    ${u.active ? 'Deactivate' : 'Activate'}
  `).join('');
  const html = `
    ${rows}
    Name
    Email
    Login
    Role
    Active
  `;
  // Bind activate/deactivate buttons after inject
  setTimeout(() => {
    document.querySelectorAll('#usersTable [data-toggle]').forEach(b => {
      b.onclick = () => toggleActive(b.dataset.toggle);
    });
  }, 0);
  return html;
}

async function toggleActive(user_id) {
  try {
    await api('/api/settings/users/toggle-active', { method: 'POST', body: { user_id } });
    refresh();
  } catch (e) {
    alert(`Update failed${e?.data?.error ? `: ${e.data.error}` : ''}.`);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
