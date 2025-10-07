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
  if (!users.length) return '<p>No users yet.</p>';

  const rows = users.map(u => `
    <tr style="border-top:1px solid #e5e7eb">
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.login_id)}</td>
      <td>${escapeHtml(u.role)}</td>
      <td>${u.active ? 'Yes' : 'No'}</td>
      <td style="text-align:right">
        <a
          class="btn btn--ghost btn--sm"
          href="?page=settings&view=user-edit&user_id=${encodeURIComponent(u.user_id)}"
        >Edit</a>
        <button
          class="btn btn--neutral btn--sm"
          data-toggle="${u.user_id}"
        >${u.active ? 'Deactivate' : 'Activate'}</button>
      </td>
    </tr>
  `).join('');

  const html = `
    <div class="table-wrap">
      <table class="table table--compact" style="border-collapse:collapse;width:100%">
        <thead>
          <tr>
            <th style="text-align:left">Name</th>
            <th style="text-align:left">Email</th>
            <th style="text-align:left">Login</th>
            <th style="text-align:left">Role</th>
            <th style="text-align:left">Active</th>
            <th style="text-align:right"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
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
