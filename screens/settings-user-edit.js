import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';

export default { load };
const $ = (id) => document.getElementById(id);

async function load(){
  const session = await ensureSession();
  if (!session?.permissions?.can_settings) {
    document.body.innerHTML = '<section class="tile"><strong>Access denied.</strong></section>';
    return;
  }

  const params = new URL(location.href).searchParams;
  const uid = params.get('user_id');
  if (!uid) { location.href='?page=settings'; return; }

  const data = await api('/api/settings/users/list');
  const u = (data.users||[]).find(x => x.user_id === uid);
  if (!u) { alert('User not found.'); location.href='?page=settings'; return; }

  // prefill
  $('user_id').value = uid;
  $('name').value = u.name || '';
  $('email').value = u.email || '';
  $('login_id').value = u.login_id || '';
  $('role').value = u.role || 'clerk';

  ['can_pos','can_cash_drawer','can_cash_payouts','can_item_research','can_inventory',
   'can_inventory_intake','can_drop_off_form','can_estimates_buy_tickets','can_timekeeping','can_settings',
   'notify_cash_drawer','notify_daily_sales_summary'].forEach(k => { $(k).checked = !!u[k]; });

  $('discount_max').value = (u.discount_max ?? '');

  // Hard guard: prevent any accidental native submit
  $('userForm').onsubmit = (e) => e.preventDefault();

  // Save via explicit click handler
  $('save').onclick = async () => {
    const payload = collect();
    if (!payload) return;

    $('save').disabled = true; $('save').textContent = 'Saving…';
    try {
      // Upsert: backend should treat presence of user_id as "update"
      await api('/api/settings/users/create', { method:'POST', body: payload });
      location.href = '?page=settings'; // back to list after success
    } catch (e2) {
      alert(`Save failed${e2?.data?.error ? `: ${e2.data.error}` : ''}.`);
    } finally {
      $('save').disabled = false; $('save').textContent = 'Save';
    }
  };
function collect(){
  const user_id = $('user_id').value; // from hidden input set during prefill
  const name = $('name').value.trim();
  const email = $('email').value.trim();
  const login_id = $('login_id').value.trim();
  const role = $('role').value;
  const discount = $('discount_max').value;

  if (!name || !email || !login_id) { alert('Please complete name, email and login.'); return null; }
  const discount_max = discount === '' ? null : Number(discount);
  if (discount_max !== null && (isNaN(discount_max) || discount_max < 0 || discount_max > 100)) {
    alert('Max discount must be between 0 and 100, or blank for unlimited.'); return null;
  }

  return {
    user_id,                            // <-- include target user
    name, email, login_id, role,
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
      can_settings: $('can_settings').checked
    },
    notifications: {
      notify_cash_drawer: $('notify_cash_drawer').checked,
      notify_daily_sales_summary: $('notify_daily_sales_summary').checked
    },
    discount_max
  };
}
