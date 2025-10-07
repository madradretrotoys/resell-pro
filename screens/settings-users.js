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

  // Permission gate
  if (!session?.permissions?.can_settings) {
    if (els.table) {
      els.table.innerHTML = `<p>Access denied. Ask an owner to grant Settings access.</p>`;
    }
    return;
  }

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
  } catch {
    els.table.innerHTML = 'Failed to load users.';
  }
}

function renderTable(users) {
  if (!users.length) return '<p>No users yet.</p>';

  const rows = users.map(u => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.login_id)}</td>
      <td>${escapeHtml(u.role)}</td>
      <td>${u.active ? 'Yes' : 'No'}</td>
      <td>
        <a href="?page=settings-user-edit&user_id=${encodeURIComponent(u.user_id)}">Edit</a>
        <button type="button" data-toggle="${u.user_id}">${u.active ? 'Deactivate' : 'Activate'}</button>
      </td>
    </tr>
  `).join('');

  const html = `
    <table class="table">
      <thead>
        <tr><th>Name</th><th>Email</th><th>Login</th><th>Role</th><th>Active</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
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
