import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';
import { showToast } from '/assets/js/ui.js';

export default { load };
const $ = (id) => document.getElementById(id);

async function load(){
  const session = await ensureSession();
  if (!session?.permissions?.can_settings) {
    document.body.innerHTML = '<section class="tile"><strong>Access denied.</strong></section>';
    return;
  }

  // Role gate for creator
  const actor = (session.membership_role || 'clerk').toLowerCase();
  const allowed =
    actor === 'owner'  ? ['owner','admin','manager','clerk'] :
    actor === 'admin'  ? ['manager','clerk'] :
    actor === 'manager'? ['clerk'] : [];
  [...$('role').options].forEach(opt => opt.disabled = !allowed.includes(opt.value));
  if (allowed.length) $('role').value = allowed[0];

  const form = $('userForm');
  const saveBtn = $('save');
  if (!form || !saveBtn) {
    notify('Unable to initialize Add User form controls.');
    return;
  }

  const onSave = async (e) => {
    if (e) e.preventDefault();
    try {
      const payload = collect();
      if (!payload) return;

      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      await api('/api/settings/users/create', { method:'POST', body: payload });
      location.href = '?page=settings';
    } catch (e2) {
      const errorCode = e2?.data?.error ? ` (${e2.data.error})` : '';
      const detail = e2?.data?.message ? ` ${e2.data.message}` : '';
      notify(`Save failed${errorCode}.${detail}`);
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save';
    }
  };

  form.addEventListener('submit', onSave);
  saveBtn.addEventListener('click', onSave);
}

function collect(){
  const name = $('name').value.trim();
  const email = $('email').value.trim();
  const login_id = $('login_id').value.trim();
  const role = $('role').value;
  const discount = $('discount_max').value;

  if (!name || !email || !login_id) { notify('Please complete name, email and login.'); return null; }
  const discount_max = discount === '' ? null : Number(discount);
  if (discount_max !== null && (isNaN(discount_max) || discount_max < 0 || discount_max > 100)) {
    notify('Max discount must be between 0 and 100, or blank for unlimited.'); return null;
  }

  return {
    name, email, login_id, role,
    temp_password: $('temp_password').value.trim() || null,
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
      can_settings: $('can_settings').checked
    },
    notifications: {
      notify_cash_drawer: $('notify_cash_drawer').checked,
      notify_daily_sales_summary: $('notify_daily_sales_summary').checked
    },
    discount_max
  };
}

function notify(message){
  try {
    showToast(message, 5000);
  } catch {
    const el = document.createElement('div');
    el.textContent = message;
    Object.assign(el.style, {
      position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
      background: '#222', color: '#fff', padding: '8px 12px', borderRadius: '8px', zIndex: '9999'
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}
