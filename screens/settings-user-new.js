import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';

export async function init(){
  await load();
}

export function destroy() {}
const $ = (id) => document.getElementById(id);

const FALLBACK_PERMISSION_COLUMNS = [
  'can_pos',
  'can_cash_drawer',
  'can_cash_payouts',
  'can_item_research',
  'can_inventory',
  'can_inventory_intake',
  'can_drop_off_form',
  'can_estimates_buy_tickets',
  'can_timekeeping',
  'can_settings',
  'notify_cash_drawer',
  'notify_daily_sales_summary',
  'can_cash_edit',
  'can_edit_timesheet',
  'clockin_required'
];

let permissionColumns = FALLBACK_PERMISSION_COLUMNS.slice();
let loginIdTouched = false;

async function load(){
  let session = null;
  try {
    session = await ensureSession();
    if (!session?.permissions?.can_settings) {
      document.body.innerHTML = '<section class="tile"><strong>Access denied.</strong></section>';
      return;
    }
  } catch {
    // Do not hard-fail rendering helpers if session bootstrap has a transient issue.
  }

  const actor = (session?.membership_role || 'clerk').toLowerCase();
  const allowed =
    actor === 'owner'  ? ['owner','admin','manager','clerk'] :
    actor === 'admin'  ? ['manager','clerk'] :
    actor === 'manager'? ['clerk'] : ['clerk'];
  [...$('role').options].forEach((opt) => { opt.disabled = !allowed.includes(opt.value); });
  if (allowed.length) $('role').value = allowed[0];

  $('userForm').onsubmit = (e) => e.preventDefault();
  $('login_id').addEventListener('input', () => { loginIdTouched = true; });

  $('middle_initial').addEventListener('input', () => {
    $('middle_initial').value = $('middle_initial').value.slice(0, 1).toUpperCase();
  });

  ['first_name', 'middle_initial', 'last_name'].forEach((id) => {
    $(id).addEventListener('input', async () => {
      updateTempPassword();
      if (!loginIdTouched) {
        const suggestion = await getSuggestedLoginId();
        if (suggestion) {
          $('login_id').value = suggestion;
          loginIdTouched = false;
        }
      }
    });
  });

  $('recommend_login').onclick = async () => {
    const suggestion = await getSuggestedLoginId();
    if (!suggestion) {
      alert('Enter first and last name first.');
      return;
    }
    $('login_id').value = suggestion;
    loginIdTouched = false;
  };

  renderPermissionGrid(permissionColumns);
  updateTempPassword();

  try {
    const meta = await api('/api/settings/users/meta');
    const fetchedCols = (meta?.permission_columns || []).filter(Boolean);
    if (fetchedCols.length) {
      permissionColumns = fetchedCols;
      renderPermissionGrid(permissionColumns);
    }
  } catch {
    // Keep fallback columns when metadata endpoint is unavailable.
  }

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

function sanitizeLoginPart(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function localSuggestion() {
  const first = sanitizeLoginPart($('first_name').value).charAt(0);
  const middle = sanitizeLoginPart($('middle_initial').value).charAt(0);
  const last = sanitizeLoginPart($('last_name').value);
  if (!first || !last) return '';

  const base = `${first}${middle}${last}`.replace(/[^a-z0-9]/g, '') || `${first}${last}`;
  const oneDigit = Math.floor(Math.random() * 9) + 1;
  return `${base}${oneDigit}`;
}

async function getSuggestedLoginId() {
  const first = $('first_name').value.trim();
  const middle = $('middle_initial').value.trim();
  const last = $('last_name').value.trim();
  if (!first || !last) return '';

  const local = localSuggestion();

  try {
    const query = new URLSearchParams({ first_name: first, middle_initial: middle, last_name: last });
    const data = await api(`/api/settings/users/meta?${query.toString()}`);
    return (data?.suggested_login_id || local || '').trim();
  } catch {
    return local;
  }
}

function updateTempPassword() {
  const first = sanitizeLoginPart($('first_name').value);
  const last = sanitizeLoginPart($('last_name').value);
  $('temp_password').value = `${(first.charAt(0) || 'u')}${last || 'ser'}001`;
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
