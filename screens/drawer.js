import { api } from '/assets/js/api.js';
import { showToast } from '/assets/js/ui.js';

let els = {};
let sessionUser = null;

export async function init({ container, session }) {
  sessionUser = session?.user || null;
  bind(container);
  wire();
  autosize(container);
}

export function destroy() {
  // no-op for now
}

function bind(root){
  const ids = [
    'drawer','period','btnLoad','btnSave','btnPing',
    'pennies','nickels','dimes','quarters','halfdollars',
    'ones','twos','fives','tens','twenties','fifties','hundreds',
    'coin_total','bill_total','grand_total','notes','status'
  ];
  ids.forEach(id => els[id] = root.querySelector('#' + id));
}

function wire(){
  // Enable Save only when a period is selected
  els.period.addEventListener('change', async () => {
    els.btnSave.disabled = !els.period.value;

    // If user picks a period, auto-load today's counts for the currently selected drawer
    if (els.period.value) {
      await loadToday();
    }
  });

  // If user switches drawers, auto-load today's counts for that drawer (only if period selected)
  els.drawer.addEventListener('change', async () => {
    if (els.period.value) {
      await loadToday();
    } else {
      // If no period selected yet, clear fields to avoid stale data confusion
      ['pennies','nickels','dimes','quarters','halfdollars','ones','twos','fives','tens','twenties','fifties','hundreds']
        .forEach(k => els[k].value = '');
      els.notes.value = '';
      recalc();
      els.status.textContent = '';
    }
  });

  // Recalculate on every input
  ['pennies','nickels','dimes','quarters','halfdollars',
   'ones','twos','fives','tens','twenties','fifties','hundreds']
    .forEach(id => els[id].addEventListener('input', recalc));

  els.btnLoad.addEventListener('click', loadToday);
  els.btnSave.addEventListener('click', save);
  if (els.btnPing) els.btnPing.addEventListener('click', ping); // <-- safe if missing
}


function autosize(root){
  // Keep it simple for now; layout is responsive via CSS classes
}

function val(id){ return Number(els[id].value || 0); }
function money(n){ return `$${n.toFixed(2)}`; }

function recalc(){
  const coin = (val('pennies')*0.01) + (val('nickels')*0.05) + (val('dimes')*0.10) + (val('quarters')*0.25) + (val('halfdollars')*0.50);
  const bill = (val('ones')*1) + (val('twos')*2) + (val('fives')*5) + (val('tens')*10) + (val('twenties')*20) + (val('fifties')*50) + (val('hundreds')*100);
  els.coin_total.textContent = money(coin);
  els.bill_total.textContent = money(bill);
  els.grand_total.textContent = money(coin + bill);
}

async function ping(){
  try {
    // You have /api/ping already
    const text = await fetch('/api/ping', { credentials:'include' }).then(r => r.text());
    els.status.textContent = `Ping: ${text}`;
    showToast('Connection OK');
  } catch {
    els.status.textContent = 'Ping failed';
    showToast('Connection failed');
  }
}

async function loadToday(){
  try{
    els.status.textContent = 'Loading…';
    const drawer = els.drawer.value || '1';
    const data = await api(`/api/cash-drawer/today?drawer=${encodeURIComponent(drawer)}`);
    // Prefill OPEN/CLOSE buckets if present; leave current inputs alone unless the matching period is loaded
    const p = els.period.value;
    const row = p === 'OPEN' ? data.open : p === 'CLOSE' ? data.close : null;
    if(row){
      for(const k of ['pennies','nickels','dimes','quarters','halfdollars','ones','twos','fives','tens','twenties','fifties','hundreds']){
        els[k].value = Number(row[k] ?? 0);
      }
      els.notes.value = row.notes ?? '';
      recalc();
      els.status.textContent = `Loaded ${p.toLowerCase()} for today`;
    }else{
      // clear inputs for a fresh entry
      ['pennies','nickels','dimes','quarters','halfdollars','ones','twos','fives','tens','twenties','fifties','hundreds'].forEach(k => els[k].value = '');
      els.notes.value = '';
      recalc();
      els.status.textContent = `No ${p ? p.toLowerCase() : ''} record yet`;
    }
  }catch(e){
    showToast('Failed to load today');
    els.status.textContent = 'Load failed';
  }
}

async function save(){
  try{
    const drawer = els.drawer.value || '1';
    const period = els.period.value;
    if(!period){ showToast('Choose a period first'); return; }
    const body = {
      drawer, period,
      pennies: val('pennies'), nickels: val('nickels'), dimes: val('dimes'), quarters: val('quarters'), halfdollars: val('halfdollars'),
      ones: val('ones'), twos: val('twos'), fives: val('fives'), tens: val('tens'), twenties: val('twenties'), fifties: val('fifties'), hundreds: val('hundreds'),
      notes: els.notes.value || null
    };
    els.btnSave.disabled = true;
    els.status.textContent = 'Saving…';
    const resp = await api('/api/cash-drawer/save', { method:'POST', body });
    showToast('Saved');
    els.status.textContent = `Saved (${resp.count_id})`;
  }catch(e){
    const status = e?.status || 500;
    if(status === 409){
      showToast('Already saved for today (locked)');
      els.status.textContent = 'Save blocked (already exists)';
    }else{
      showToast('Save failed');
      els.status.textContent = 'Save failed';
    }
  }finally{
    els.btnSave.disabled = false;
  }
}
