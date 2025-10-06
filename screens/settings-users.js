import { apiFetch, ensureSession } from '/assets/js/api.js';

const els = {};
function $(id){ return document.getElementById(id); }

async function load() {
  const session = await ensureSession(); // has login + permissions
  els.table = $('usersTable');
  els.btnRefresh = $('btnRefresh');
  els.btnAdd = $('btnAddUser');
  els.btnInvite = $('btnInvite');
  els.modal = $('userModal');
  els.form  = $('userForm');
  els.title = $('umTitle');

  // form fields
  ['umName','umEmail','umLogin','umRole','can_pos','can_cash_drawer','can_cash_payouts','can_item_research',
   'can_inventory','can_inventory_intake','can_drop_off_form','can_estimates_buy_tickets','can_timekeeping',
   'can_settings','notify_cash_drawer','notify_daily_sales_summary','discount_max'
  ].forEach(id => els[id] = $(id));

  // Gate: needs can_settings true; server will re-check
  if (!session?.permissions?.can_settings) {
    els.table.innerHTML = `<div class="tile"><strong>Access denied.</strong> Ask an owner to grant Settings access.</div>`;
    $('btnAddUser').style.display = 'none';
    $('btnInvite').style.display = 'none';
  }

  els.btnRefresh.onclick = refresh;
  els.btnAdd.onclick = () => openModal();
  els.btnInvite.onclick = () => alert('Email invite will be added in a later phase.');

  els.form.onsubmit = submitForm;
  $('umCancel').onclick = () => closeModal();

  await refresh();
}

async function refresh(){
  els.table.innerHTML = 'Loading…';
  const res = await apiFetch('/api/settings/users/list');
  if (!res.ok) { els.table.innerHTML = 'Failed to load users.'; return; }
  const data = await res.json();
  els.table.innerHTML = renderTable(data.users);
}

function renderTable(users){
  if (!users?.length) return '<div>No users yet.</div>';
  const rows = users.map(u => `
    <tr>
      <td>${u.name}</td>
      <td>${u.email}</td>
      <td>${u.login_id}</td>
      <td>${u.role}</td>
      <td>${u.active ? 'Yes' : 'No'}</td>
      <td style="text-align:right">
        <button class="btn btn--neutral btn--sm" data-edit="${u.user_id}">Edit</button>
        <button class="btn btn--ghost btn--sm" data-toggle="${u.user_id}">
          ${u.active ? 'Deactivate' : 'Activate'}
        </button>
      </td>
    </tr>
  `).join('');

  // table + event delegation
  const html = `
    <table style="width:100%; border-collapse:collapse;">
      <thead><tr>
        <th>Name</th><th>Email</th><th>Login</th><th>Role</th><th>Active</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  setTimeout(() => {
    els.table.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editUser(b.dataset.edit));
    els.table.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => toggleActive(b.dataset.toggle));
  }, 0);
  return html;
}

function openModal(user){
  els.modal.style.display = 'block';
  els.title.textContent = user ? 'Edit user' : 'Add user';
  if (user) {
    els.umName.value = user.name || '';
    els.umEmail.value = user.email || '';
    els.umLogin.value = user.login_id || '';
    els.umRole.value  = user.role || 'clerk';
    // perms
    ['can_pos','can_cash_drawer','can_cash_payouts','can_item_research','can_inventory','can_inventory_intake',
     'can_drop_off_form','can_estimates_buy_tickets','can_timekeeping','can_settings',
     'notify_cash_drawer','notify_daily_sales_summary'].forEach(k => els[k].checked = !!user[k]);
    els.discount_max.value = user.discount_max ?? '';
    els.modal.dataset.editing = user.user_id;
  } else {
    els.form.reset();
    els.modal.dataset.editing = '';
  }
}

function closeModal(){ els.modal.style.display = 'none'; }

async function submitForm(ev){
  ev.preventDefault();
  const payload = {
    name: els.umName.value.trim(),
    email: els.umEmail.value.trim(),
    login_id: els.umLogin.value.trim(),
    role: els.umRole.value,
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

  const editing = els.modal.dataset.editing;
  const url = editing ? '/api/settings/users/update' : '/api/settings/users/create';
  if (editing) payload.user_id = editing;

  const res = await apiFetch(url, { method:'POST', body: JSON.stringify(payload) });
  if (!res.ok) { alert('Save failed.'); return; }
  closeModal();
  refresh();
}

async function editUser(user_id){
  const res = await apiFetch('/api/settings/users/list');
  if (!res.ok) return alert('Could not load users.');
  const data = await res.json();
  const user = (data.users||[]).find(u => u.user_id === user_id);
  if (!user) return alert('User not found.');
  openModal(user);
}

async function toggleActive(user_id){
  const res = await apiFetch('/api/settings/users/toggle-active', { method:'POST', body: JSON.stringify({ user_id }) });
  if (!res.ok) return alert('Update failed.');
  refresh();
}

export default { load };
