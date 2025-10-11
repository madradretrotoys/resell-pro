//Begin settings-users.js
import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';
import { applyButtonGroupColors } from '/assets/js/ui.js';

const els = {};
function $(id){ return document.getElementById(id); }

// Router expects an `init` entrypoint: mod.init({ container, session })
export async function init({ container, session }){
  // Ensure we have session (router already does, but safe to double-check)
  if (!session?.user){ session = await ensureSession(); }

  // Bind elements (IDs must exist in settings-users.html)
  els.table = $('usersTable');
  const btnInvite = $('btnInvite');
  const btnRefresh = $('btnRefresh');

  if (btnInvite){ btnInvite.onclick = () => alert('Email invite will be added in a later phase.'); }

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

function renderTable(users){
  if (!users.length) return '<div class="muted">No users yet.</div>';

  const rows = users.map(u => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.login_id)}</td>
      <td>${escapeHtml(u.role)}</td>
      <td>${u.active ? 'Yes' : 'No'}</td>
      <td>
        <div class="btn-group">
          <button class="btn btn-sm btn-ghost" data-edit="${u.id || ''}">Edit</button>
          ${u.active
            ? `<button class="btn btn-sm btn-danger" data-toggle="${u.id}">Deactivate</button>`
            : `<button class="btn btn-sm btn-primary" data-toggle="${u.id}">Activate</button>`
          }
        </div>
      </td>
    </tr>
  `).join('');

  const html = `
    <table class="table">
      <thead>
        <tr>
          <th>Name</th><th>Email</th><th>Login</th><th>Role</th><th>Active</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // Bind actions after inject
  setTimeout(() => {
    document.querySelectorAll('#usersTable [data-toggle]').forEach(b => {
      b.onclick = () => toggleActive(b.dataset.toggle);
    });
    // Optional: Edit click hook (placeholder)
    document.querySelectorAll('#usersTable [data-edit]').forEach(b => {
      b.onclick = () => alert('Edit user will be added in a later phase.');
    });
    // Normalize button roles within each btn-group
    document.querySelectorAll('#usersTable .btn-group').forEach(g => applyButtonGroupColors(g));
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
//End settings-users.js
