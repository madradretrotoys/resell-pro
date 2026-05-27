import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';
import { applyButtonGroupColors } from '/assets/js/ui.js';

const els = {};
function $(id){ return document.getElementById(id); }

// Router expects an `init` entrypoint: mod.init({ container, session })
export async function init({ container, session }){
  const session = await ensureSession();
  if (!session?.permissions?.can_settings) {
    document.body.innerHTML = '<section class="tile"><strong>Access denied.</strong></section>';
    return;
}

function collect(){
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
