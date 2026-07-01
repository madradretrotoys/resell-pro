
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
  els.dialog = $('accessDialog');
  els.accessTitle = $('accessTitle');
  els.accessSubtitle = $('accessSubtitle');
  els.assignmentsTable = $('assignmentsTable');
  els.accessScope = $('accessScope');
  els.accessEntity = $('accessEntity');
  els.accessEntityWrap = $('accessEntityWrap');
  els.accessRole = $('accessRole');
  els.accessActive = $('accessActive');
  els.btnSaveAccess = $('btnSaveAccess');
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
          <button class="btn btn-sm btn-ghost" data-edit="${u.user_id || ''}">Edit</button>
          <button class="btn btn-sm btn-primary" data-access="${u.user_id || ''}">Access</button>
          <button class="btn btn-sm btn-danger" data-delete="${u.user_id || ''}">Delete</button>
          ${u.active
            ? `<button class="btn btn-sm btn-danger" data-toggle="${u.user_id || ''}">Deactivate</button>`
            : `<button class="btn btn-sm btn-primary" data-toggle="${u.user_id || ''}">Activate</button>`
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
    document.querySelectorAll('#usersTable [data-delete]').forEach(b => {
      b.onclick = () => deleteUser(b.dataset.delete);
    });
    document.querySelectorAll('#usersTable [data-access]').forEach(b => {
      b.onclick = () => openAccessDialog(b.dataset.access);
    });
    // Optional: Edit click hook (placeholder)
    document.querySelectorAll('#usersTable [data-edit]').forEach(b => {
      b.onclick = () => { location.href = `?page=settings-user-edit&user_id=${encodeURIComponent(b.dataset.edit)}`; };
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

async function deleteUser(user_id) {
  const sure = confirm('Delete this user? This removes their membership and may permanently delete the user record.');
  if (!sure) return;
  try {
    await api('/api/settings/users/delete', { method: 'POST', body: { user_id } });
    refresh();
  } catch (e) {
    alert(`Delete failed${e?.data?.error ? `: ${e.data.error}` : ''}.`);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}


let accessState = { userId: '', data: null };

async function openAccessDialog(userId) {
  accessState.userId = userId;
  els.assignmentsTable.innerHTML = '<div class="muted">Loading assignments…</div>';
  if (els.dialog?.showModal) els.dialog.showModal();
  try {
    const data = await api(`/api/settings/users/assignments?user_id=${encodeURIComponent(userId)}`);
    accessState.data = data;
    els.accessTitle.textContent = `Manage access · ${data.user?.name || 'User'}`;
    els.accessSubtitle.textContent = `${data.user?.email || ''} · Assign this user to organizations, businesses, and tenant locations.`;
    configureScopeOptions();
    renderAssignments(data.assignments || []);
  } catch (e) {
    els.assignmentsTable.innerHTML = `<div class="banner banner--error">Unable to load assignments${e?.data?.error ? `: ${escapeHtml(e.data.error)}` : ''}.</div>`;
  }
}

function configureScopeOptions() {
  const data = accessState.data || {};
  const canPlatform = !!data.can_manage_platform;
  [...els.accessScope.options].forEach((opt) => {
    if (opt.value === 'platform') opt.hidden = !canPlatform;
  });
  if (els.accessScope.value === 'platform' && !canPlatform) els.accessScope.value = 'organization';
  els.accessScope.onchange = refreshAccessFormOptions;
  els.btnSaveAccess.onclick = saveAssignment;
  refreshAccessFormOptions();
}

function refreshAccessFormOptions() {
  const data = accessState.data || {};
  const scope = els.accessScope.value;
  const options = data.options || {};
  const roles = scope === 'platform' ? (options.platform_roles || []) : (options.tenant_roles || []);
  els.accessRole.innerHTML = roles.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(labelRole(role))}</option>`).join('');
  els.accessEntityWrap.hidden = scope === 'platform';
  let entities = [];
  if (scope === 'organization') entities = options.organizations || [];
  if (scope === 'business') entities = options.businesses || [];
  if (scope === 'tenant') entities = options.tenants || [];
  els.accessEntity.innerHTML = entities.length
    ? entities.map((row) => `<option value="${escapeHtml(row.entity_id)}">${escapeHtml(row.entity_name)}</option>`).join('')
    : '<option value="">No choices available</option>';
}

async function saveAssignment() {
  const scope = els.accessScope.value;
  const entity_id = scope === 'platform' ? null : els.accessEntity.value;
  if (scope !== 'platform' && !entity_id) return alert('Select an organization, business, or tenant.');
  els.btnSaveAccess.disabled = true;
  els.btnSaveAccess.textContent = 'Saving…';
  try {
    await api('/api/settings/users/assignments', {
      method: 'POST',
      body: { user_id: accessState.userId, scope, entity_id, role: els.accessRole.value, active: els.accessActive.checked }
    });
    await openAccessDialog(accessState.userId);
  } catch (e) {
    alert(`Unable to save assignment${e?.data?.error ? `: ${e.data.error}` : ''}.`);
  } finally {
    els.btnSaveAccess.disabled = false;
    els.btnSaveAccess.textContent = 'Save assignment';
  }
}

function renderAssignments(assignments) {
  if (!assignments.length) {
    els.assignmentsTable.innerHTML = '<div class="muted">No assignments yet.</div>';
    return;
  }
  els.assignmentsTable.innerHTML = `
    <table class="table">
      <thead><tr><th>Scope</th><th>Name</th><th>Role</th><th>Active</th><th></th></tr></thead>
      <tbody>${assignments.map((a) => `
        <tr>
          <td>${escapeHtml(labelRole(a.scope))}</td>
          <td>${escapeHtml(a.entity_name || 'Resell Pro Platform')}</td>
          <td>${escapeHtml(labelRole(a.role))}</td>
          <td>${a.active ? 'Yes' : 'No'}</td>
          <td><button class="btn btn-sm btn-danger" data-remove-assignment="${escapeHtml(a.scope)}|${escapeHtml(a.entity_id || '')}|${escapeHtml(a.role)}">Remove</button></td>
        </tr>`).join('')}</tbody>
    </table>`;
  document.querySelectorAll('[data-remove-assignment]').forEach((btn) => {
    btn.onclick = () => removeAssignment(btn.dataset.removeAssignment || '');
  });
}

async function removeAssignment(raw) {
  const [scope, entity_id, role] = raw.split('|');
  if (!confirm('Remove this assignment?')) return;
  try {
    await api('/api/settings/users/assignments', {
      method: 'POST',
      body: { user_id: accessState.userId, scope, entity_id: entity_id || null, role, remove: true }
    });
    await openAccessDialog(accessState.userId);
  } catch (e) {
    alert(`Unable to remove assignment${e?.data?.error ? `: ${e.data.error}` : ''}.`);
  }
}

function labelRole(value) {
  return String(value || '').replace(/^platform_/, 'platform ').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
