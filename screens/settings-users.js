import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';
import { apiFetch, ensureSession } from '/assets/js/api.js';

const els = {};
function $(id){ return document.getElementById(id); }

export default {
  load
};

async function load() {
  const session = await ensureSession(); // includes permissions + membership role
  bindEls();

  // UX gate (server also enforces)
  if (!session?.permissions?.can_settings) {
    els.table.innerHTML = `<div class="tile"><strong>Access denied.</strong> Ask an owner to grant Settings access.</div>`;
    els.btnAdd.style.display = 'none';
    els.btnInvite.style.display = 'none';
    return;
  }

  els.btnRefresh.onclick = refresh;
  els.btnAdd.onclick = () => openModal(null, session);
  els.btnInvite.onclick = () => alert('Email invite will be added in a later phase.');
  els.form.onsubmit = (ev) => submitForm(ev, session);
  els.btnCancel.onclick = closeModal;

  await refresh();
}

function bindEls(){
  els.table = $('usersTable');
  els.btnRefresh = $('btnRefresh');
  els.btnAdd = $('btnAddUser');
  els.btnInvite = $('btnInvite');

  els.modal = $('userModal');
  els.form  = $('userForm');
  els.title = $('umTitle');
  els.btnCancel = $('umCancel');

  // inputs
  ['umName','umEmail','umLogin','umRole','umTempPass',
   'can_pos','can_cash_drawer','can_cash_payouts','can_item_research',
   'can_inventory','can_inventory_intake','can_drop_off_form','can_estimates_buy_tickets',
   'can_timekeeping','can_settings','notify_cash_drawer','notify_daily_sales_summary',
   'discount_max'
  ].forEach(id => els[id] = $(id));
}

async function refresh(){
  els.table.innerHTML = 'Loading…';
  const res = await apiFetch('/api/settings/users/list');
  if (!res.ok) { els.table.innerHTML = 'Failed to load users.'; return; }
  const data = await res.json();
  els.table.innerHTML = renderTable(data.users || []);
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
      <td style="text-align:right">
        <button class="btn btn--neutral btn--sm" data-edit="${u.user_id}">Edit</button>
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

  // wire row actions after insert
  setTimeout(() => {
    els.table.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editUser(b.dataset.edit, users));
    els.table.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => toggleActive(b.dataset.toggle));
  }, 0);

  return html;
}

function openModal(user, session){
  els.modal.style.display = 'block';
  els.title.textContent = user ? 'Edit user' : 'Add user';

  // Role gate for creator — restrict selectable roles per your policy
  const actor = (session?.membership_role || 'clerk').toLowerCase();
  const allowedRoles =
    actor === 'owner'  ? ['owner','admin','manager','clerk'] :
    actor === 'admin'  ? ['manager','clerk'] :
    actor === 'manager'? ['clerk'] :
                         [];
  // disable disallowed options
  [...els.umRole.options].forEach(opt => opt.disabled = !allowedRoles.includes(opt.value));

  if (user) {
    // Pre-fill
    els.umName.value = user.name || '';
    els.umEmail.value = user.email || '';
    els.umLogin.value = user.login_id || '';
    els.umRole.value  = allowedRoles.includes(user.role) ? user.role : allowedRoles[allowedRoles.length-1] || 'clerk';
    els.umTempPass.value = '';

    // perms
    ['can_pos','can_cash_drawer','can_cash_payouts','can_item_research','can_inventory','can_inventory_intake',
     'can_drop_off_form','can_estimates_buy_tickets','can_timekeeping','can_settings',
     'notify_cash_drawer','notify_daily_sales_summary'].forEach(k => els[k].checked = !!user[k]);

    els.discount_max.value = user.discount_max ?? '';
    els.modal.dataset.editing = user.user_id;
  } else {
    els.form.reset();
    els.umRole.value = allowedRoles[0] || 'clerk';
    els.modal.dataset.editing = '';
  }
}

function closeModal(){
  els.modal.style.display = 'none';
}

async function submitForm(ev, session){
  ev.preventDefault();

  const actorRole = (session?.membership_role || 'clerk').toLowerCase();
  const targetRole = String(els.umRole.value).toLowerCase();

  // client-side role gate
  const allowed =
    actorRole === 'owner' ||
    (actorRole === 'admin'   && ['manager','clerk'].includes(targetRole)) ||
    (actorRole === 'manager' && targetRole === 'clerk');

  if (!allowed) { alert('Your role cannot create that role.'); return; }

  const payload = {
    name: els.umName.value.trim(),
    email: els.umEmail.value.trim(),
    login_id: els.umLogin.value.trim(),
    role: targetRole,
    temp_password: els.umTempPass.value.trim() || null,
    permissions: {
      can_pos: els.can_pos.checked,
      can_cash_drawer: els.can_cash_drawer.checked,
      can_cash_payouts: els.can_cash_payouts.checked,
      can_item_research: els.can_item_research.checked,
      can_inventory: els.can_inventory.checked,
      can_inventory_intake: els.can_inventory_intake.checked,
      can_drop_off_form: els.can_drop_off_form.checked,
      can_estimates_buy_tickets: els.can_estimates_buy_tickets.checked,
      can_timekeeping: els.can_timekeeping.checked,
      can_settings: els.can_settings.checked
    },
    notifications: {
      notify_cash_drawer: els.notify_cash_drawer.checked,
      notify_daily_sales_summary: els.notify_daily_sales_summary.checked
    },
    discount_max: els.discount_max.value === '' ? null : Number(els.discount_max.value)
  };

  // Basic validation
  if (!payload.name || !payload.email || !payload.login_id) { alert('Please complete name, email and login.'); return; }
  if (payload.discount_max !== null && (isNaN(payload.discount_max) || payload.discount_max < 0 || payload.discount_max > 100)) {
    alert('Max discount must be between 0 and 100, or blank for unlimited.'); return;
  }

  // Choose endpoint (create only for now)
  const editing = els.modal.dataset.editing;
  if (editing) {
    // (Edit endpoint will be added in a later patch; for now treat as create)
  }

  setSaving(true);
  const res = await apiFetch('/api/settings/users/create', { method:'POST', body: JSON.stringify(payload) });
  setSaving(false);

  if (!res.ok) {
    const err = await safeJson(res);
    alert(`Save failed${err?.error ? `: ${err.error}` : ''}.`);
    return;
  }

  closeModal();
  refresh();
}

async function toggleActive(user_id){
  const res = await apiFetch('/api/settings/users/toggle-active', { method:'POST', body: JSON.stringify({ user_id }) });
  if (!res.ok) {
    const err = await safeJson(res);
    alert(`Update failed${err?.error ? `: ${err.error}` : ''}.`);
    return;
  }
  refresh();
}

/* Helpers */

function setSaving(on){
  els.umSave?.toggleAttribute?.('disabled', !!on);
  if (on) els.umSave.textContent = 'Saving…'; else els.umSave.textContent = 'Save';
}

async function safeJson(res){
  try { return await res.json(); } catch { return null; }
}

function editUser(user_id, users){
  const u = (users||[]).find(x => x.user_id === user_id);
  if (!u) return alert('User not found.');
  ensureSession().then(session => openModal(u, session));
}

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
