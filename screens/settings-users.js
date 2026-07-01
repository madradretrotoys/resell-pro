
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
  els.userSearchQuery = $('userSearchQuery');
  els.btnUserSearch = $('btnUserSearch');
  els.userSearchResults = $('userSearchResults');
  els.effectiveTenantsTable = $('effectiveTenantsTable');
  els.accessBanner = $('accessBanner');
  const btnInvite = $('btnInvite');
  const btnRefresh = $('btnRefresh');

  if (btnInvite){ btnInvite.onclick = () => alert('Email invite will be added in a later phase.'); }

  // Permission gate handled server-side by /api/settings/users/list.
  // Proceed and show a friendly message only if the API returns 403.

  if (btnRefresh) btnRefresh.onclick = refresh;
  if (els.btnUserSearch) els.btnUserSearch.onclick = searchUsers;
  if (els.userSearchQuery) els.userSearchQuery.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); searchUsers(); }
  });

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
    clearAccessBanner();
    configureScopeOptions();
    renderAssignments(data.assignments || []);
    renderEffectiveTenants(data.effective_tenants || []);
  } catch (e) {
    showAccessBanner(`Unable to load assignments${e?.data?.error ? `: ${escapeHtml(e.data.error)}` : ''}.`, 'error');
    els.assignmentsTable.innerHTML = '<div class="muted">Assignments could not be loaded.</div>';
  }
}

function configureScopeOptions() {
  const data = accessState.data || {};
  const roleOptionsByScope = data.options?.role_options_by_scope || {};
  [...els.accessScope.options].forEach((opt) => {
    const roles = roleOptionsByScope[opt.value] || [];
    opt.hidden = roles.length === 0;
    opt.disabled = roles.length === 0;
  });
  if (els.accessScope.selectedOptions?.[0]?.disabled) {
    const firstAllowed = [...els.accessScope.options].find((opt) => !opt.disabled);
    if (firstAllowed) els.accessScope.value = firstAllowed.value;
  }
  els.accessScope.onchange = refreshAccessFormOptions;
  els.btnSaveAccess.onclick = saveAssignment;
  refreshAccessFormOptions();
}

function refreshAccessFormOptions() {
  const data = accessState.data || {};
  const scope = els.accessScope.value;
  const options = data.options || {};
  const roleOptionsByScope = options.role_options_by_scope || {};
  const roles = roleOptionsByScope[scope] || [];
  els.accessRole.innerHTML = roles.length
    ? roles.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(labelRole(role))}</option>`).join('')
    : '<option value="">No roles available</option>';
  els.btnSaveAccess.disabled = roles.length === 0;
  els.accessEntityWrap.hidden = scope === 'platform';
  let entities = [];
  if (scope === 'organization') entities = options.organizations || [];
  if (scope === 'business') entities = options.businesses || [];
  if (scope === 'tenant') entities = options.tenants || [];
  els.accessEntity.innerHTML = entities.length
    ? entities.map((row) => `<option value="${escapeHtml(row.entity_id)}">${escapeHtml(row.entity_name)}</option>`).join('')
    : '<option value="">No choices available</option>';
  if (scope !== 'platform' && !entities.length) els.btnSaveAccess.disabled = true;
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
    showAccessBanner('Assignment saved.', 'success');
  } catch (e) {
    showAccessBanner(accessErrorMessage(e, 'Unable to save assignment.'), 'error');
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
    showAccessBanner('Assignment removed.', 'success');
  } catch (e) {
    showAccessBanner(accessErrorMessage(e, 'Unable to remove assignment.'), 'error');
  }
}

function labelRole(value) {
  return String(value || '').replace(/^platform_/, 'platform ').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}


async function searchUsers() {
  const q = els.userSearchQuery?.value?.trim() || '';
  if (q.length < 2) {
    els.userSearchResults.innerHTML = '<div class="muted">Enter at least 2 characters.</div>';
    return;
  }
  els.userSearchResults.innerHTML = '<div class="muted">Searching…</div>';
  try {
    const data = await api(`/api/settings/users/search?q=${encodeURIComponent(q)}`);
    renderUserSearchResults(data.users || []);
  } catch (e) {
    els.userSearchResults.innerHTML = `<div class="banner banner--error">Unable to search users${e?.data?.error ? `: ${escapeHtml(e.data.error)}` : ''}.</div>`;
  }
}

function renderUserSearchResults(users) {
  if (!users.length) {
    els.userSearchResults.innerHTML = '<div class="muted">No users found. Try an exact email or login ID for users outside the current organization.</div>';
    return;
  }
  els.userSearchResults.innerHTML = `
    <table class="table">
      <thead><tr><th>Name</th><th>Email</th><th>Login</th><th>Match</th><th></th></tr></thead>
      <tbody>${users.map((u) => `
        <tr>
          <td>${escapeHtml(u.name)}</td>
          <td>${escapeHtml(u.email)}</td>
          <td>${escapeHtml(u.login_id)}</td>
          <td>${escapeHtml(u.match_source || '')}</td>
          <td><button class="btn btn-sm btn-primary" data-search-access="${escapeHtml(u.user_id)}">Access</button></td>
        </tr>`).join('')}</tbody>
    </table>`;
  document.querySelectorAll('[data-search-access]').forEach((btn) => {
    btn.onclick = () => openAccessDialog(btn.dataset.searchAccess || '');
  });
}

function renderEffectiveTenants(rows) {
  if (!els.effectiveTenantsTable) return;
  if (!rows.length) {
    els.effectiveTenantsTable.innerHTML = '<div class="muted">No active tenant/location access.</div>';
    return;
  }
  els.effectiveTenantsTable.innerHTML = `
    <table class="table">
      <thead><tr><th>Tenant / Location</th><th>Access source</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr>
          <td>${escapeHtml(row.tenant_name)}</td>
          <td>${escapeHtml(row.access_source)}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}


function showAccessBanner(message, type = 'info') {
  if (!els.accessBanner) return;
  els.accessBanner.hidden = false;
  els.accessBanner.className = `banner banner--${type}`;
  els.accessBanner.textContent = message;
}

function clearAccessBanner() {
  if (!els.accessBanner) return;
  els.accessBanner.hidden = true;
  els.accessBanner.textContent = '';
  els.accessBanner.className = 'banner';
}

function accessErrorMessage(error, fallback) {
  const code = error?.data?.error || '';
  if (code === 'last_platform_owner') return 'At least one active platform owner is required. Add another platform owner before changing this assignment.';
  if (code === 'forbidden_scope') return 'You do not have permission to assign that scope.';
  if (code === 'forbidden_platform') return 'Only platform owners/admins can manage platform assignments.';
  if (code === 'platform_owner_required') return 'Only a platform owner can change another platform owner assignment.';
  if (code === 'invalid_role') return 'That role is not valid for the selected scope.';
  if (code === 'insufficient_role_scope') return 'Your role cannot grant that access level.';
  return code ? `${fallback} (${code})` : fallback;
}
