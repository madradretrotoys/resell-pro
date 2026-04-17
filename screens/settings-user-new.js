import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';

export default { load };
const $ = (id) => document.getElementById(id);

let permissionColumns = [];
let loginIdTouched = false;

async function load(){
  const session = await ensureSession();
  if (!session?.permissions?.can_settings) {
    document.body.innerHTML = '<section class="tile"><strong>Access denied.</strong></section>';
    return;
  }

  const actor = (session.membership_role || 'clerk').toLowerCase();
  const allowed =
    actor === 'owner'  ? ['owner','admin','manager','clerk'] :
    actor === 'admin'  ? ['manager','clerk'] :
    actor === 'manager'? ['clerk'] : [];
  [...$('role').options].forEach((opt) => { opt.disabled = !allowed.includes(opt.value); });
  if (allowed.length) $('role').value = allowed[0];

  $('userForm').onsubmit = (e) => e.preventDefault();
  $('login_id').addEventListener('input', () => { loginIdTouched = true; });

  ['first_name', 'middle_initial', 'last_name'].forEach((id) => {
    $(id).addEventListener('input', async () => {
      updateTempPassword();
      if (!loginIdTouched) await recommendLoginId();
    });
  });

  $('recommend_login').onclick = async () => {
    await recommendLoginId(true);
  };

  const meta = await api('/api/settings/users/meta');
  permissionColumns = (meta.permission_columns || []).slice();
  renderPermissionGrid(permissionColumns);

  updateTempPassword();

  $('save').onclick = async () => {
    const payload = collect();
    if (!payload) return;

    $('save').disabled = true; $('save').textContent = 'Saving…';
    try {
      await api('/api/settings/users/create', { method:'POST', body: payload });
      location.href = '?page=settings';
    } catch (e2) {
      alert(`Save failed${e2?.data?.error ? `: ${e2.data.error}` : ''}.`);
    } finally {
      $('save').disabled = false; $('save').textContent = 'Save';
    }
  };
}

function toLabel(name) {
  return name
    .replace(/^can_/, '')
    .replace(/^notify_/, 'notify ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderPermissionGrid(columns){
  const grid = $('permissionGrid');
  grid.innerHTML = '';
  columns.forEach((col) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" data-permission="${col}"> ${toLabel(col)}`;

    if (col === 'can_cash_drawer' || col === 'can_item_research' || col === 'can_timekeeping') {
      const input = label.querySelector('input');
      if (input) input.checked = true;
    }

    grid.appendChild(label);
  });
}

async function recommendLoginId(force = false) {
  const first = $('first_name').value.trim();
  const middle = $('middle_initial').value.trim();
  const last = $('last_name').value.trim();
  if (!first || !last) return;

  const query = new URLSearchParams({ first_name: first, middle_initial: middle, last_name: last });
  const data = await api(`/api/settings/users/meta?${query.toString()}`);
  const suggested = (data?.suggested_login_id || '').trim();

  if (!suggested) return;
  if (force || !$('login_id').value.trim() || !loginIdTouched) {
    $('login_id').value = suggested;
    loginIdTouched = false;
  }
}

function updateTempPassword() {
  const first = $('first_name').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const last = $('last_name').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const val = `${(first.charAt(0) || 'u')}${last || 'ser'}001`;
  $('temp_password').value = val;
}

function collect(){
  const first_name = $('first_name').value.trim();
  const middle_initial = $('middle_initial').value.trim().slice(0, 1).toUpperCase();
  const last_name = $('last_name').value.trim();
  const email = $('email').value.trim();
  const login_id = $('login_id').value.trim();
  const role = $('role').value;
  const discount = $('discount_max').value;

  if (!first_name || !last_name || !login_id) {
    alert('Please complete first name, last name, and login ID.');
    return null;
  }

  const discount_max = discount === '' ? null : Number(discount);
  if (discount_max !== null && (isNaN(discount_max) || discount_max < 0 || discount_max > 100)) {
    alert('Max discount must be between 0 and 100, or blank for unlimited.');
    return null;
  }

  const permissions = {};
  permissionColumns.forEach((col) => {
    const el = document.querySelector(`input[data-permission="${col}"]`);
    permissions[col] = !!el?.checked;
  });

  return {
    first_name,
    middle_initial,
    last_name,
    email,
    login_id,
    role,
    temp_password: $('temp_password').value,
    permissions,
    discount_max,
  };
}
