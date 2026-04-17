import { api } from '/assets/js/api.js';
import { showToast } from '/assets/js/ui.js';

let els = {};
let sessionUser = null;

export async function init({ container, session }) {
  sessionUser = session?.user || null;
  bind(container);
  wire();
   // ✅ Load section previews
  await refreshSafePreview();
  await refreshMovementPreview();
  setupCashReportUI();
  if (canCashEdit()) await loadCashReport();
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
    'coin_total','bill_total','grand_total','notes','status',
    // Phase 1: balance + movement
    'balanceBanner',
    'move_from','move_to','move_amount','move_notes','btnMoveSave','move_status',

    // ✅ Safe counts
    'safe_period','safe_amount','safe_notes','btnSafeSave','safe_status',

    // ✅ history + last saved preview
  'drawer_last_saved','safe_last_saved','move_last_saved',
  'btnDrawerHistory','btnSafeHistory','btnMoveHistory',

  // ✅ modal
  'historyModal','historyBackdrop','btnCloseHistory','historyTitle','historySubtitle',
  'historyLoading','historyEmpty','historyRows',
  'cashReportSection','reportPreset','reportFrom','reportTo','btnReportLoad','reportStatus','reportTotals','reportDrawerRows','reportPathRows'
    
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
  if (els.btnMoveSave) {
    els.btnMoveSave.addEventListener('click', saveMovement);
  }
  
  if (els.btnSafeSave) {
    els.btnSafeSave.addEventListener('click', saveSafeCount);
  }
  if (els.btnPing) els.btnPing.addEventListener('click', ping); // <-- safe if missing
  // History buttons
  if (els.btnDrawerHistory) els.btnDrawerHistory.addEventListener('click', () => openHistory('drawer'));
  if (els.btnSafeHistory) els.btnSafeHistory.addEventListener('click', () => openHistory('safe'));
  if (els.btnMoveHistory) els.btnMoveHistory.addEventListener('click', () => openHistory('movement'));

  // Modal close
  if (els.btnCloseHistory) els.btnCloseHistory.addEventListener('click', closeHistory);
  if (els.historyBackdrop) els.historyBackdrop.addEventListener('click', closeHistory);

  if (els.btnReportLoad) els.btnReportLoad.addEventListener('click', loadCashReport);
  if (els.reportPreset) {
    els.reportPreset.addEventListener('change', () => {
      toggleCustomDates();
    });
  }
}



async function saveSafeCount() {
  try {
    const period = (els.safe_period?.value || '').replace(/^Safe/i, '').trim().toUpperCase();
    const amount = Number(els.safe_amount?.value || 0);
    const notes = (els.safe_notes?.value || '').trim();

    if (!period) { showToast('Choose a Safe period'); return; }
    if (!amount || amount <= 0) { showToast('Enter a valid Safe amount'); return; }

    els.btnSafeSave.disabled = true;
    els.safe_status.textContent = 'Saving safe count…';

    const body = {
      period,
      amount,
      notes: notes || null
    };

    // ✅ new endpoint we will create
    const resp = await api('/api/cash-safe/save', { method: 'POST', body });

    showToast('Safe count saved');
    els.safe_status.textContent = `Saved (${resp.safe_count_id})`;

    // Reset UI fields (optional)
    els.safe_period.value = '';
    els.safe_amount.value = '';
    els.safe_notes.value = '';

    await refreshSafePreview();
    if (canCashEdit()) await loadCashReport();
    
  } catch (e) {
    const status = e?.status || 500;

    if (status === 409) {
      showToast('Safe count already saved for today');
      els.safe_status.textContent = 'Already saved today';
    } else if (status === 401) {
      showToast('You are not logged in');
      els.safe_status.textContent = 'Unauthorized';
    } else {
      showToast('Safe save failed');
      els.safe_status.textContent = 'Save failed';
    }
  } finally {
    els.btnSafeSave.disabled = false;
  }
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
    renderBalanceBanner(data);
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

    // ✅ Last saved preview for drawer counts (use most recent of open/close for selected drawer)
    const last = (data?.close && data.close.count_ts) ? data.close : (data?.open && data.open.count_ts) ? data.open : null;

    if (els.drawer_last_saved) {
      if (!last) {
        els.drawer_last_saved.textContent = 'No records yet today';
      } else {
        const ts = fmtDate(last.count_ts);
        const amt = fmtMoney(last.grand_total);
        els.drawer_last_saved.textContent = `Last saved: ${ts} • Drawer ${drawer} ${last.period} • ${amt}`;
      }
    }
    
  }catch(e){
    showToast('Failed to load today');
    els.status.textContent = 'Load failed';
  }
}


function canCashEdit() {
  return !!(sessionUser?.permissions?.can_cash_edit ?? sessionUser?.can_cash_edit);
}

function setupCashReportUI() {
  if (!els.cashReportSection) return;

  if (!canCashEdit()) {
    els.cashReportSection.classList.add('hidden');
    return;
  }

  els.cashReportSection.classList.remove('hidden');
  const today = new Date().toISOString().slice(0, 10);
  if (els.reportFrom && !els.reportFrom.value) els.reportFrom.value = today;
  if (els.reportTo && !els.reportTo.value) els.reportTo.value = today;
  toggleCustomDates();
}

function toggleCustomDates() {
  const isCustom = (els.reportPreset?.value || 'today') === 'custom';
  if (els.reportFrom) els.reportFrom.disabled = !isCustom;
  if (els.reportTo) els.reportTo.disabled = !isCustom;
}

async function loadCashReport() {
  if (!canCashEdit() || !els.btnReportLoad) return;

  const preset = (els.reportPreset?.value || 'today').toLowerCase();
  const from = (els.reportFrom?.value || '').trim();
  const to = (els.reportTo?.value || '').trim();

  if (preset === 'custom' && (!from || !to)) {
    showToast('Choose from and to dates for custom report');
    return;
  }

  try {
    els.btnReportLoad.disabled = true;
    if (els.reportStatus) els.reportStatus.textContent = 'Loading report…';

    const q = new URLSearchParams({ preset });
    if (preset === 'custom') {
      q.set('from', from);
      q.set('to', to);
    }

    const data = await api(`/api/cash-report/summary?${q.toString()}`);
    renderCashReport(data);
  } catch (e) {
    if (els.reportStatus) els.reportStatus.textContent = 'Report failed to load';
    showToast('Cash report failed');
  } finally {
    els.btnReportLoad.disabled = false;
  }
}

function renderCashReport(data) {
  const totals = data?.totals || {};
  const range = data?.range || {};

  if (els.reportStatus) {
    els.reportStatus.textContent = `${range.start_date || ''} to ${range.end_date || ''} (${(range.timezone || '').toString()})`;
  }

  if (els.reportTotals) {
    const cards = [
      ['Drawer Opens', fmtMoney(totals.drawer_open_total)],
      ['Drawer Closes', fmtMoney(totals.drawer_close_total)],
      ['Safe Opens', fmtMoney(totals.safe_open_total)],
      ['Safe Closes', fmtMoney(totals.safe_close_total)],
      ['Drawer Move In', fmtMoney(totals.movement_in_total)],
      ['Drawer Move Out', fmtMoney(totals.movement_out_total)],
      ['Cash Sales In', fmtMoney(totals.cash_sales_total)],
      ['Payouts Out', fmtMoney(totals.payout_total)],
    ];

    els.reportTotals.innerHTML = cards.map(([k, v]) => `
      <div class="p-2 rounded border">
        <div class="text-xs text-gray-600">${k}</div>
        <div class="font-semibold">${v}</div>
      </div>
    `).join('');
  }

  if (els.reportDrawerRows) {
    const rows = Array.isArray(data?.drawer_summary) ? data.drawer_summary : [];
    els.reportDrawerRows.innerHTML = rows.length ? rows.map((r) => {
      const inAmt = Number(r.movement_in || 0);
      const outAmt = Number(r.movement_out || 0);
      const payout = Number(r.payout_out || 0);
      const net = inAmt - outAmt - payout;
      return `
        <tr class="border-b">
          <td class="px-3 py-2">Drawer ${r.drawer}</td>
          <td class="px-3 py-2">${fmtMoney(r.open_total)}</td>
          <td class="px-3 py-2">${fmtMoney(r.close_total)}</td>
          <td class="px-3 py-2">${fmtMoney(inAmt)}</td>
          <td class="px-3 py-2">${fmtMoney(outAmt)}</td>
          <td class="px-3 py-2">${fmtMoney(payout)}</td>
          <td class="px-3 py-2">${fmtMoney(net)}</td>
        </tr>
      `;
    }).join('') : '<tr><td class="px-3 py-2 text-gray-600" colspan="7">No drawer activity in range.</td></tr>';
  }

  if (els.reportPathRows) {
    const rows = Array.isArray(data?.movement_paths) ? data.movement_paths : [];
    els.reportPathRows.innerHTML = rows.length ? rows.map((r) => `
      <tr class="border-b">
        <td class="px-3 py-2">${r.from_location} → ${r.to_location}</td>
        <td class="px-3 py-2">${Number(r.moves || 0)}</td>
        <td class="px-3 py-2">${fmtMoney(r.amount_total)}</td>
      </tr>
    `).join('') : '<tr><td class="px-3 py-2 text-gray-600" colspan="3">No movements in range.</td></tr>';
  }
}

function renderBalanceBanner(data) {
  if (!els.balanceBanner) return;

   // can_cash_edit may be exposed either directly on the user or nested under permissions
  const canEdit = canCashEdit();

  const status = String(data?.review_status || '');
  const expected = Number(data?.expected_at_latest ?? NaN);
  const variance = Number(data?.variance_at_latest ?? NaN);

  // If no evaluation is possible yet, hide banner
  if (!status) {
    els.balanceBanner.classList.add('hidden');
    return;
  }

  els.balanceBanner.classList.remove('hidden');

  const isBalanced = status === 'balanced';
  const severe = Number.isFinite(variance) && Math.abs(variance) >= 5;

  // Employees (no edit permission) get status only, no amounts.
  if (!canEdit) {
    els.balanceBanner.textContent = isBalanced ? `✅ Balanced` : `⚠ Needs review — Call manager`;
    els.balanceBanner.className = isBalanced
      ? 'mb-2 p-2 rounded border text-sm bg-green-50 border-green-200 text-green-800'
      : 'mb-2 p-2 rounded border text-sm bg-red-50 border-red-200 text-red-800';
    return;
  }

  // Managers get full transparency
  if (!Number.isFinite(expected)) {
    els.balanceBanner.textContent = isBalanced ? `✅ Balanced` : `⚠ Needs review`;
    els.balanceBanner.className = isBalanced
      ? 'mb-2 p-2 rounded border text-sm bg-green-50 border-green-200 text-green-800'
      : 'mb-2 p-2 rounded border text-sm bg-red-50 border-red-200 text-red-800';
    return;
  }

  if (isBalanced) {
    els.balanceBanner.textContent = `Expected: $${expected.toFixed(2)} ✅ Balanced`;
    els.balanceBanner.className = 'mb-2 p-2 rounded border text-sm bg-green-50 border-green-200 text-green-800';
    return;
  }

  const label = variance > 0
    ? `Over by $${variance.toFixed(2)}`
    : `Short by $${Math.abs(variance).toFixed(2)}`;

  els.balanceBanner.textContent = `Expected: $${expected.toFixed(2)} • Variance: ${label}`;

  els.balanceBanner.className = severe
    ? 'mb-2 p-2 rounded border text-sm bg-red-50 border-red-200 text-red-800'
    : 'mb-2 p-2 rounded border text-sm bg-yellow-50 border-yellow-200 text-yellow-800';
}

async function saveMovement() {
  try {
    const from_location = els.move_from.value;
    const to_location = els.move_to.value;
    const amount = Number(els.move_amount.value || 0);
    const notes = (els.move_notes.value || '').trim();

    if (!from_location || !to_location) { showToast('Choose From and To locations'); return; }
    if (from_location === to_location) { showToast('From and To cannot match'); return; }
    if (!amount || amount <= 0) { showToast('Enter a valid amount'); return; }

    // Require notes if Purchase involved
    if ((from_location === 'Purchase' || to_location === 'Purchase') && !notes) {
      showToast('Notes are required for purchases');
      return;
    }

    els.btnMoveSave.disabled = true;
    els.move_status.textContent = 'Saving movement…';

    const body = { from_location, to_location, amount, notes: notes || null };
    const resp = await api('/api/cash-ledger/save', { method: 'POST', body });

    showToast('Movement saved');
    els.move_status.textContent = `Saved (${resp.row.ledger_id})`;

    // reset fields
    els.move_from.value = '';
    els.move_to.value = '';
    els.move_amount.value = '';
    els.move_notes.value = '';

    // Refresh today payload (so expected/variance reflects new movement)
    await loadToday();
    await refreshMovementPreview();
    if (canCashEdit()) await loadCashReport();

  } catch (e) {
    const status = e?.status || 500;
    if (status === 400) {
      showToast('Invalid movement entry');
      els.move_status.textContent = 'Invalid movement';
    } else if (status === 401) {
      showToast('You are not logged in');
      els.move_status.textContent = 'Unauthorized';
    } else {
      showToast('Movement save failed');
      els.move_status.textContent = 'Save failed';
    }
  } finally {
    els.btnMoveSave.disabled = false;
  }
}

async function refreshSafePreview() {
  try {
    const data = await api('/api/cash-safe/today');
    if (!els.safe_last_saved) return;

    if (!data?.row) {
      els.safe_last_saved.textContent = 'No records yet today';
      return;
    }

    const r = data.row;
    els.safe_last_saved.textContent = `Last saved: ${fmtDate(r.count_date)} • ${r.period} • ${fmtMoney(r.amount)}`;
  } catch {
    // ignore
  }
}

async function refreshMovementPreview() {
  try {
    const data = await api('/api/cash-ledger/history?limit=1');
    if (!els.move_last_saved) return;

    const r = data?.rows?.[0];
    if (!r) {
      els.move_last_saved.textContent = 'No movements yet';
      return;
    }

    els.move_last_saved.textContent = `Last saved: ${fmtDate(r.created_at)} • ${r.from_location} → ${r.to_location} • ${fmtMoney(r.amount)}`;
  } catch {
    // ignore
  }
}

function openHistory(type) {
  if (!els.historyModal) return;

  els.historyModal.classList.remove('hidden');
  els.historyRows.innerHTML = '';
  els.historyEmpty.classList.add('hidden');
  els.historyLoading.classList.remove('hidden');

  if (type === 'drawer') {
    els.historyTitle.textContent = 'Drawer Counts History';
    els.historySubtitle.textContent = 'Recent OPEN/CLOSE counts for this drawer';
    loadDrawerHistory();
  }

  if (type === 'safe') {
    els.historyTitle.textContent = 'Safe Counts History';
    els.historySubtitle.textContent = 'Recent OPEN/CLOSE safe counts';
    loadSafeHistory();
  }

  if (type === 'movement') {
    els.historyTitle.textContent = 'Cash Movement & Payouts History';
    els.historySubtitle.textContent = 'Recent ledger entries';
    loadMovementHistory();
  }
}

function closeHistory() {
  if (!els.historyModal) return;
  els.historyModal.classList.add('hidden');
}

function fmtDate(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return String(ts || '');
  }
}

function fmtMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '';
  return `$${x.toFixed(2)}`;
}

function rowHtml(date, details, amount) {
  return `
    <tr class="border-b">
      <td class="px-3 py-2 whitespace-nowrap">${date}</td>
      <td class="px-3 py-2">${details}</td>
      <td class="px-3 py-2 whitespace-nowrap">${amount}</td>
    </tr>
  `;
}

async function loadDrawerHistory() {
  try {
    const drawer = els.drawer?.value || '1';
    const data = await api(`/api/cash-drawer/history?drawer=${encodeURIComponent(drawer)}&limit=30`);

    els.historyLoading.classList.add('hidden');

    if (!data?.rows?.length) {
      els.historyEmpty.classList.remove('hidden');
      return;
    }

    els.historyRows.innerHTML = data.rows.map(r => {
      const date = fmtDate(r.count_ts);
      const details = `Drawer ${r.drawer} • ${r.period}`;
      const amount = fmtMoney(r.grand_total);
      return rowHtml(date, details, amount);
    }).join('');

  } catch (e) {
    els.historyLoading.classList.add('hidden');
    els.historyEmpty.classList.remove('hidden');
  }
}

async function loadSafeHistory() {
  try {
    const data = await api(`/api/cash-safe/history?limit=30`);

    els.historyLoading.classList.add('hidden');

    if (!data?.rows?.length) {
      els.historyEmpty.classList.remove('hidden');
      return;
    }

    els.historyRows.innerHTML = data.rows.map(r => {
      const date = fmtDate(r.count_date);
      const details = `${r.period}`;
      const amount = fmtMoney(r.amount);
      return rowHtml(date, details, amount);
    }).join('');

  } catch (e) {
    els.historyLoading.classList.add('hidden');
    els.historyEmpty.classList.remove('hidden');
  }
}

async function loadMovementHistory() {
  try {
    const data = await api(`/api/cash-ledger/history?limit=30`);

    els.historyLoading.classList.add('hidden');

    if (!data?.rows?.length) {
      els.historyEmpty.classList.remove('hidden');
      return;
    }

    els.historyRows.innerHTML = data.rows.map(r => {
      const date = fmtDate(r.created_at);
      const details = `${r.from_location} → ${r.to_location}`;
      const amount = fmtMoney(r.amount);
      return rowHtml(date, details, amount);
    }).join('');

  } catch (e) {
    els.historyLoading.classList.add('hidden');
    els.historyEmpty.classList.remove('hidden');
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
    // Refresh banner/status after save
    await loadToday();
    if (canCashEdit()) await loadCashReport();
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
