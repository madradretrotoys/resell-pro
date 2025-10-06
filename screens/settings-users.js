import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';

const els = {};
function $(id){ return document.getElementById(id); }
export default { load };

async function load() {
  const session = await ensureSession();
  els.table = $('usersTable');
  $('btnInvite').onclick = () => alert('Email invite will be added in a later phase.');

  if (!session?.permissions?.can_settings) {
    els.table.innerHTML = `<div class="tile"><strong>Access denied.</strong> Ask an owner to grant Settings access.</div>`;
    return;
  }

  $('btnRefresh').onclick = refresh;
  await refresh();
}

async function refresh(){
  els.table.innerHTML = 'Loading…';
  try {
    const data = await api('/api/settings/users/list');
    els.table.innerHTML = renderTable(data.users || []);
  } catch {
    els.table.innerHTML = 'Failed to load users.';
  }
}

function renderTable(users){
  if (!users.length) return '<div>No users yet.</div>';
    const rows = users.map(u => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.login_id)}</td>
      <td>${escapeHtml(u.role)}</td>
      <td>${u.active ? 'Yes' : 'No'}</td>
      <td style="text-align:right; white-space:nowrap;">
        <a class="btn btn--neutral btn--sm"
           href="?page=settings&view=user-edit&user_id=${encodeURIComponent(u.user_id)}">Edit</a>
        <button class="btn btn--ghost btn--sm" data-toggle="${u.user_id}">
          ${u.active ? 'Deactivate' : 'Activate'}
        </button>
      </td>
    </tr>
  `).join('');

  const html = `
    <table style="width:100%; border-collapse:collapse;">
      <thead><tr>
        <th>Name</th><th>Email</th><th>Login</th><th>Role</th><th>Active</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  setTimeout(() => {
    els.table.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => toggleActive(b.dataset.toggle));
  }, 0);
  return html;
}

async function toggleActive(user_id){
  try {
    await api('/api/settings/users/toggle-active', { method:'POST', body: { user_id } });
    refresh();
  } catch (e) {
    alert(`Update failed${e?.data?.error ? `: ${e.data.error}` : ''}.`);
  }
}

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
