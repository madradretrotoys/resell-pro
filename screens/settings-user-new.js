import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';

function $(id){ return document.getElementById(id); }

let assignmentOptions = null;

// Router expects an `init` entrypoint: mod.init({ container, session })
export async function init({ container, session }){
  // Ensure we have session (router already does, but safe to double-check)
  if (!session?.user){ session = await ensureSession(); }

  // Hard guard: prevent accidental native submit
  $('userForm').onsubmit = (e) => e.preventDefault();

  await loadAssignmentOptions();

  // Save via explicit click handler
  $('save').onclick = async () => {
    const payload = collect();
    if (!payload) return;

    $('save').disabled = true; $('save').textContent = 'Saving…';
    try {
      await api('/api/settings/users/create', { method:'POST', body: payload });
      location.href = '?page=settings-users';
    } catch (e) {
      alert(`Save failed${e?.data?.error ? `: ${e.data.error}` : ''}.`);
    } finally {
      $('save').disabled = false; $('save').textContent = 'Save';
    }
  };
}

async function loadAssignmentOptions() {
  const help = $('assignment_help');
  help.textContent = 'Loading assignment options…';
  try {
    const data = await api('/api/settings/users/assignment-options');
    assignmentOptions = data.options || {};
    $('assignment_scope').onchange = refreshAssignmentControls;
    $('platform_enabled').onchange = refreshPlatformControls;
    refreshPlatformControls();
    refreshAssignmentControls();
    help.textContent = 'Select the initial customer organization, business, or tenant/location assignment for this user.';
  } catch (e) {
    assignmentOptions = null;
    help.textContent = 'Assignment options could not be loaded. The user will be created in the current tenant.';
    ['platform_enabled', 'platform_role', 'assignment_scope', 'assignment_entity', 'assignment_role', 'assignment_active'].forEach((id) => { const el = $(id); if (el) el.disabled = true; });
  }
}

function refreshPlatformControls() {
  const roles = assignmentOptions?.role_options_by_scope?.platform || [];
  const enabled = $('platform_enabled').checked;
  $('platform_role_wrap').hidden = !enabled;
  $('platform_role_wrap').style.display = enabled ? '' : 'none';
  $('platform_role').innerHTML = roles.length
    ? roles.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(labelRole(role))}</option>`).join('')
    : '<option value="">No platform roles available</option>';
  $('platform_role').disabled = !enabled || roles.length === 0;
  $('platform_help').textContent = enabled
    ? 'Platform role identifies the user as internal Resell Pro staff. Customer visibility is still assigned separately.'
    : 'Leave unchecked for customer-only users.';
}

function refreshAssignmentControls() {
  const options = assignmentOptions || {};
  const roleOptionsByScope = options.role_options_by_scope || {};
  const scopeSelect = $('assignment_scope');
  [...scopeSelect.options].forEach((opt) => {
    const roles = roleOptionsByScope[opt.value] || [];
    opt.hidden = roles.length === 0;
    opt.disabled = roles.length === 0;
  });
  if (scopeSelect.selectedOptions?.[0]?.disabled) {
    const firstAllowed = [...scopeSelect.options].find((opt) => !opt.disabled);
    if (firstAllowed) scopeSelect.value = firstAllowed.value;
  }

  const scope = scopeSelect.value;
  const roles = roleOptionsByScope[scope] || [];
  $('assignment_role').innerHTML = roles.length
    ? roles.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(labelRole(role))}</option>`).join('')
    : '<option value="">No roles available</option>';

  let entities = [];
  if (scope === 'organization') entities = options.organizations || [];
  if (scope === 'business') entities = options.businesses || [];
  if (scope === 'tenant') entities = options.tenants || [];
  $('assignment_entity').innerHTML = entities.length
    ? entities.map((row) => `<option value="${escapeHtml(row.entity_id)}">${escapeHtml(row.entity_name)}</option>`).join('')
    : '<option value="">No choices available</option>';

  const disabled = roles.length === 0 || entities.length === 0;
  $('assignment_role').disabled = disabled;
  $('assignment_entity').disabled = disabled;
}

function collect(){
  const name = $('name').value.trim();
  const email = $('email').value.trim();
  const login_id = $('login_id').value.trim();
  const discount = $('discount_max').value;

  if (!name || !email || !login_id) { alert('Please complete name, email and login.'); return null; }
  const discount_max = discount === '' ? null : Number(discount);
  if (discount_max !== null && (isNaN(discount_max) || discount_max < 0 || discount_max > 100)) {
    alert('Max discount must be between 0 and 100, or blank for unlimited.'); return null;
  }

  const assignment = collectAssignment();
  if (assignment === false) return null;
  const platform_assignment = collectPlatformAssignment();
  if (platform_assignment === false) return null;
  const role = deriveLegacyRole(assignment, platform_assignment);

  return {
    name, email, login_id, role,
    temp_password: $('temp_password').value.trim() || null,
    assignment,
    platform_assignment,
    permissions: {
      can_pos: $('can_pos').checked,
      can_cash_drawer: $('can_cash_drawer').checked,
      can_cash_payouts: $('can_cash_payouts').checked,
      can_item_research: $('can_item_research').checked,
      can_inventory: $('can_inventory').checked,
      can_inventory_intake: $('can_inventory_intake').checked,
      can_drop_off_form: $('can_drop_off_form').checked,
      can_estimates_buy_tickets: $('can_estimates_buy_tickets').checked,
      can_timekeeping: $('can_timekeeping').checked,
      clockin_required: $('clockin_required').checked,
      can_settings: $('can_settings').checked,
      can_add_tenant: $('can_add_tenant').checked
    },
    notifications: {
      notify_cash_drawer: $('notify_cash_drawer').checked,
      notify_daily_sales_summary: $('notify_daily_sales_summary').checked
    },
    discount_max
  };
}

function collectPlatformAssignment() {
  if (!assignmentOptions || !$('platform_enabled').checked) return null;
  const role = $('platform_role').value;
  if (!role) {
    alert('Select a platform role or uncheck Internal platform user.');
    return false;
  }
  return { scope: 'platform', entity_id: null, role, active: true };
}

function collectAssignment() {
  if (!assignmentOptions) return null;
  const scope = $('assignment_scope').value;
  const role = $('assignment_role').value;
  const entity_id = $('assignment_entity').value;
  if (!scope || !role) return null;
  if (!entity_id) {
    alert('Select an organization, business, or tenant for the customer access assignment.');
    return false;
  }
  return { scope, entity_id, role, active: $('assignment_active').checked };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function labelRole(value) {
  return String(value || '').replace(/^platform_/, 'platform ').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveLegacyRole(assignment, platformAssignment) {
  const role = String(assignment?.role || platformAssignment?.role || '').toLowerCase();
  if (['owner', 'admin', 'manager', 'clerk'].includes(role)) return role;
  if (role === 'platform_owner') return 'owner';
  if (role === 'platform_admin' || role === 'platform_support') return 'admin';
  return 'clerk';
}
