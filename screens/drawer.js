import { api } from '/assets/js/api.js';
import { showToast } from '/assets/js/ui.js';

let els = {};
let sessionUser = null;
const BASE_DENOM_IDS = ['pennies','nickels','dimes','quarters','halfdollars','ones','twos','fives','tens','twenties','fifties','hundreds'];
const ROLL_IDS = ['penny_rolls','nickel_rolls','dime_rolls','quarter_rolls','halfdollar_rolls','smalldollar_rolls','largedollar_rolls'];
const EXTRA_COIN_IDS = ['dollarcoins','largedollarcoins'];
const ALL_COUNT_INPUT_IDS = [...BASE_DENOM_IDS, ...ROLL_IDS, ...EXTRA_COIN_IDS];
const FIELD_MULTIPLIERS = {
  pennies: 0.01,
  penny_rolls: 0.50,
  nickels: 0.05,
  nickel_rolls: 2.00,
  dimes: 0.10,
  dime_rolls: 5.00,
  quarters: 0.25,
  quarter_rolls: 10.00,
  halfdollars: 0.50,
  halfdollar_rolls: 10.00,
  dollarcoins: 1.00,
  smalldollar_rolls: 25.00,
  largedollarcoins: 1.00,
  largedollar_rolls: 20.00,
  ones: 1.00,
  twos: 2.00,
  fives: 5.00,
  tens: 10.00,
  twenties: 20.00,
  fifties: 50.00,
  hundreds: 100.00,
};

export async function init({ container, session }) {
  sessionUser = session?.user || null;
  bind(container);
  await loadTenantDrawers();
  wire();
  wireCashReportFallback(container);
   // ✅ Load section previews
  await refreshSafePreview();
  await refreshMovementPreview();
  setupCashReportUI();
  if (els.cashReportSection && !els.cashReportSection.classList.contains('hidden')) {
    await loadCashReport();
  }
  recalc();
  autosize(container);
}

export function destroy() {
  // no-op for now
}

function bind(root){
  const ids = [
    'drawer','period','btnLoad','btnSave','btnPing',
    'pennies','nickels','dimes','quarters','halfdollars',
    'penny_rolls','nickel_rolls','dime_rolls','quarter_rolls','halfdollar_rolls',
    'dollarcoins','largedollarcoins','smalldollar_rolls','largedollar_rolls',
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
  root.querySelectorAll('.cd-amt[id]').forEach((el) => {
    els[el.id] = el;
  });
  els.drawerRequired = Array.from(root.querySelectorAll('.drawer-required'));
  els.countRequired = Array.from(root.querySelectorAll('.count-required'));
}

function wire(){
  setDrawerSelectionState();
  // Enable Save only when a period is selected
  els.period.addEventListener('change', async () => {
    setDrawerSelectionState();

    // If user picks a period, auto-load today's counts for the currently selected drawer
    if (els.period.value) {
      await loadToday();
    } else {
      clearDrawerForm();
    }
  });

  // If user switches drawers, auto-load today's counts for that drawer (only if period selected)
  els.drawer.addEventListener('change', async () => {
    setDrawerSelectionState();
    if (!hasDrawerSelection()) {
      clearDrawerForm();
      return;
    }
    if (els.period.value) {
      await loadToday();
    } else {
      clearDrawerForm();
      if (els.status) els.status.textContent = 'Choose Open or Close to begin entering counts.';
    }
  });

  // Recalculate on every input
  ALL_COUNT_INPUT_IDS
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

  if (els.btnReportLoad) {
    els.btnReportLoad.addEventListener('click', loadCashReport);
    els.__reportBound = true;
  }
  if (els.reportDrawerRows) {
    els.reportDrawerRows.addEventListener('click', onReportDetailToggle);
  }
  if (els.reportPreset) {
    els.reportPreset.addEventListener('change', () => {
      toggleCustomDates();
    });
  }
}

async function loadTenantDrawers() {
  if (!els.drawer) return;
  const fallbackOptions = Array.from(els.drawer.querySelectorAll('option'));
  try {
    const resp = await api('/api/settings/drawers/list');
    const rows = Array.isArray(resp?.drawers) ? resp.drawers : [];
    const activeRows = rows.filter((r) => r?.is_active !== false);
    if (!activeRows.length) return;

    const normalized = activeRows.map((r, idx) => {
      const codeNum = String(r?.drawer_code || '').match(/^D(\d+)$/i)?.[1];
      const nameNum = String(r?.drawer_name || '').match(/drawer\s+(\d+)/i)?.[1];
      const legacyDrawer = Number(codeNum || nameNum || (idx + 1));
      return {
        legacyDrawer: Number.isFinite(legacyDrawer) && legacyDrawer > 0 ? String(legacyDrawer) : String(idx + 1),
        label: String(r?.drawer_name || `Drawer ${idx + 1}`),
      };
    });

    els.drawer.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select drawer…';
    els.drawer.appendChild(placeholder);

    for (const d of normalized) {
      const opt = document.createElement('option');
      opt.value = d.legacyDrawer;
      opt.textContent = d.label;
      els.drawer.appendChild(opt);
    }
  } catch {
    // keep existing hardcoded fallback options
    if (!fallbackOptions.length) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select drawer…';
      els.drawer.appendChild(placeholder);
    }
  }
}

function hasDrawerSelection() {
  return !!String(els.drawer?.value || '').trim();
}
function hasPeriodSelection() {
  return !!String(els.period?.value || '').trim();
}

function clearDrawerForm() {
  ALL_COUNT_INPUT_IDS.forEach(k => { if (els[k]) els[k].value = ''; });
  if (els.notes) els.notes.value = '';
  recalc();
  if (els.status) {
    if (!hasDrawerSelection()) els.status.textContent = 'Select a drawer to start counting.';
    else if (!hasPeriodSelection()) els.status.textContent = 'Choose Open or Close to begin entering counts.';
    else els.status.textContent = '';
  }
}

function setDrawerSelectionState() {
  const drawerEnabled = hasDrawerSelection();
  const countEnabled = drawerEnabled && hasPeriodSelection();
  (els.drawerRequired || []).forEach((el) => {
    el.disabled = !drawerEnabled;
  });
  (els.countRequired || []).forEach((el) => {
    el.disabled = !countEnabled;
  });
  if (!drawerEnabled && els.period) els.period.value = '';
  if (els.btnSave) els.btnSave.disabled = !countEnabled;
}

function wireCashReportFallback(root) {
  if (!root || els.__reportBound) return;
  root.addEventListener('click', (ev) => {
    const t = ev?.target;
    if (!(t instanceof Element)) return;
    const btn = t.closest('#btnReportLoad');
    if (!btn) return;
    console.log('[drawer] fallback click handler fired for Run Report');
    ev.preventDefault();
    loadCashReport();
  });
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
    if (canLoadCashReportUi()) await loadCashReport();
    
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
  const penniesTotal = val('pennies') + (val('penny_rolls') * 50);
  const nickelsTotal = val('nickels') + (val('nickel_rolls') * 40);
  const dimesTotal = val('dimes') + (val('dime_rolls') * 50);
  const quartersTotal = val('quarters') + (val('quarter_rolls') * 40);
  const halfDollarTotal = val('halfdollars') + (val('halfdollar_rolls') * 20);
  const smallDollarCoinTotal = val('dollarcoins') + (val('smalldollar_rolls') * 25);
  const largeDollarCoinTotal = val('largedollarcoins') + (val('largedollar_rolls') * 20);
  const coin = (penniesTotal*0.01) + (nickelsTotal*0.05) + (dimesTotal*0.10) + (quartersTotal*0.25) + (halfDollarTotal*0.50) + smallDollarCoinTotal + largeDollarCoinTotal;
  const bill = (val('ones')*1) + (val('twos')*2) + (val('fives')*5) + (val('tens')*10) + (val('twenties')*20) + (val('fifties')*50) + (val('hundreds')*100);
  els.coin_total.textContent = money(coin);
  els.bill_total.textContent = money(bill);
  els.grand_total.textContent = money(coin + bill);
  updateFieldTotals();
}

function updateFieldTotals() {
  for (const [id, mult] of Object.entries(FIELD_MULTIPLIERS)) {
    const totalEl = els[`amt_${id}`];
    if (!totalEl) continue;
    totalEl.textContent = money(val(id) * mult);
  }
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
    if (!hasDrawerSelection()) {
      clearDrawerForm();
      return;
    }
    els.status.textContent = 'Loading…';
    const drawer = els.drawer.value;
    const data = await api(`/api/cash-drawer/today?drawer=${encodeURIComponent(drawer)}`);
    renderBalanceBanner(data);
    // Prefill OPEN/CLOSE buckets if present; leave current inputs alone unless the matching period is loaded
    const p = els.period.value;
    const row = p === 'OPEN' ? data.open : p === 'CLOSE' ? data.close : null;
    if(row){
      for (const k of BASE_DENOM_IDS) {
        if (els[k]) els[k].value = Number(row[k] ?? 0);
      }
      for (const k of ROLL_IDS) {
        if (els[k]) els[k].value = Number(row[k] ?? 0);
      }
      for (const k of EXTRA_COIN_IDS) {
        if (els[k]) els[k].value = Number(row[k] ?? 0);
      }
      els.notes.value = row.notes ?? '';
      recalc();
      els.status.textContent = `Loaded ${p.toLowerCase()} for today`;
    }else{
      // clear inputs for a fresh entry
      clearDrawerForm();
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
  const direct = sessionUser?.can_cash_edit;
  if (typeof direct === 'boolean') return direct;
  if (typeof direct === 'number') return direct === 1;
  if (typeof direct === 'string') return ['1', 'true', 'yes', 'y'].includes(direct.toLowerCase());

  const perms = sessionUser?.permissions;
  if (Array.isArray(perms)) {
    const normalized = perms.map((x) => String(x || '').toLowerCase().trim());
    return normalized.includes('can_cash_edit')
      || normalized.includes('cash_edit')
      || normalized.includes('cash:edit');
  }

  if (perms && typeof perms === 'object') {
    const v = perms.can_cash_edit;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1;
    if (typeof v === 'string') return ['1', 'true', 'yes', 'y'].includes(v.toLowerCase());
  }

  return false;
}

function setupCashReportUI() {
  if (!els.cashReportSection) return;

  els.cashReportSection.classList.remove('hidden');
  if (!canCashEdit()) {
    console.warn('[drawer] setupCashReportUI: canCashEdit is false; report section left visible for diagnostics');
  }
  // Default managers to current week (Sun-Sat), and show local dates (not UTC).
  const now = new Date();
  const localToday = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  const weekday = localToday.getDay(); // 0=Sun
  const weekStart = new Date(localToday);
  weekStart.setDate(localToday.getDate() - weekday);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const ymd = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  if (els.reportPreset) els.reportPreset.value = 'week';
  if (els.reportFrom) els.reportFrom.value = ymd(weekStart);
  if (els.reportTo) els.reportTo.value = ymd(weekEnd);
  toggleCustomDates();
}

function toggleCustomDates() {
  const isCustom = (els.reportPreset?.value || 'today') === 'custom';
  if (els.reportFrom) els.reportFrom.disabled = !isCustom;
  if (els.reportTo) els.reportTo.disabled = !isCustom;
}

function canLoadCashReportUi() {
  return !!(els.cashReportSection && !els.cashReportSection.classList.contains('hidden'));
}

async function loadCashReport() {
  if (!els.btnReportLoad) {
    console.warn('[drawer] loadCashReport skipped', {
      canCashEdit: canCashEdit(),
      hasButton: !!els.btnReportLoad,
    });
    return;
  }

  const preset = (els.reportPreset?.value || 'today').toLowerCase();
  const from = (els.reportFrom?.value || '').trim();
  const to = (els.reportTo?.value || '').trim();
  const reqId = Math.random().toString(36).slice(2, 10);

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
    console.log('[drawer] loadCashReport:start', { reqId, preset, from, to, query: q.toString() });

    const data = await api(`/api/cash-report/summary?${q.toString()}`);
    console.log('[drawer] loadCashReport:success', {
      reqId,
      ok: !!data?.ok,
      range: data?.range || null,
      totals: data?.totals || null,
      counts: {
        drawer_summary: Array.isArray(data?.drawer_summary) ? data.drawer_summary.length : 0,
        movement_paths: Array.isArray(data?.movement_paths) ? data.movement_paths.length : 0,
        drawer_counts: Array.isArray(data?.activity?.drawer_counts) ? data.activity.drawer_counts.length : 0,
        safe_counts: Array.isArray(data?.activity?.safe_counts) ? data.activity.safe_counts.length : 0,
        ledger_moves: Array.isArray(data?.activity?.ledger_moves) ? data.activity.ledger_moves.length : 0,
        cash_sales: Array.isArray(data?.activity?.cash_sales) ? data.activity.cash_sales.length : 0,
      },
    });
    renderCashReport(data);
  } catch (e) {
    console.error('[drawer] loadCashReport:failed', {
      reqId,
      message: e?.message || String(e),
      status: e?.status || null,
      data: e?.data || null,
    });
    if (els.reportStatus) els.reportStatus.textContent = 'Report failed to load';
    showToast('Cash report failed');
  } finally {
    els.btnReportLoad.disabled = false;
  }
}

function renderCashReport(data) {
  const totals = data?.totals || {};
  const range = data?.range || {};
  console.log('[drawer] renderCashReport', {
    range,
    totals,
    drawerSummaryCount: Array.isArray(data?.drawer_summary) ? data.drawer_summary.length : 0,
    movementPathCount: Array.isArray(data?.movement_paths) ? data.movement_paths.length : 0,
  });

  if (els.reportStatus) {
    els.reportStatus.textContent = `${range.start_date || ''} to ${range.end_date || ''} (${(range.timezone || '').toString()})`;
  }

  if (els.reportTotals) {
    // Totals card strip intentionally hidden per manager request.
    els.reportTotals.innerHTML = '';
  }

  if (els.reportDrawerRows) {
    const groups = Array.isArray(data?.daily_by_drawer) ? data.daily_by_drawer : [];
    const detailMap = buildDailyDetailMap(data);
    els.reportDrawerRows.innerHTML = groups.length ? groups.map((g) => {
      const drawerRowClass = getDrawerRowClass(g.drawer);
      const dayRows = (Array.isArray(g.days) ? g.days : []).map((r) => {
        const variance = Number(r.variance || 0);
        const varianceClass = getVarianceClass(variance, false);
        const detailKey = `${String(g.drawer || '')}::${String(r.date || '')}`;
        const detailId = `report-detail-${safeDomId(detailKey)}`;
        const detail = detailMap.get(detailKey) || emptyDailyDetail();
        return `
          <tr class="border-b ${drawerRowClass}">
            <td class="px-3 py-2">
              <span>${r.date}</span>
              <div class="mt-2">
                <button
                  type="button"
                  class="btn btn--neutral btn--sm"
                  data-detail-toggle="${detailId}"
                  aria-expanded="false"
                >Show Details</button>
              </div>
            </td>
            <td class="px-3 py-2">${fmtMoney(r.open_total)}</td>
            <td class="px-3 py-2">${fmtMoney(r.close_total)}</td>
            <td class="px-3 py-2">${fmtMoney(r.sales_in)}</td>
            <td class="px-3 py-2">${fmtMoney(r.movement_in)}</td>
            <td class="px-3 py-2">${fmtMoney(r.movement_out)}</td>
            <td class="px-3 py-2">${fmtMoney(r.payout_out)}</td>
            <td class="px-3 py-2">${fmtMoney(r.expected_close)}</td>
            <td class="px-3 py-2 ${varianceClass}">${fmtMoney(r.variance)}</td>
          </tr>
          <tr id="${detailId}" class="border-b report-detail-row" style="display:none;">
            <td class="px-3 py-2" colspan="9">${renderDailyDetails(detail, range.timezone)}</td>
          </tr>
        `;
      }).join('');

      const t = g.totals || {};
      const totalVar = Number(t.variance || 0);
      const totalVarClass = getVarianceClass(totalVar, true);

      return `
        <tr class="${drawerRowClass} border-y">
          <td class="px-3 py-2 font-semibold" colspan="9">Drawer ${g.drawer}</td>
        </tr>
        ${dayRows}
        <tr class="border-b report-total-row">
          <td class="px-3 py-2 font-bold">Totals</td>
          <td class="px-3 py-2 font-bold">${fmtMoney(t.open_total)}</td>
          <td class="px-3 py-2 font-bold">${fmtMoney(t.close_total)}</td>
          <td class="px-3 py-2 font-bold">${fmtMoney(t.sales_in)}</td>
          <td class="px-3 py-2 font-bold">${fmtMoney(t.movement_in)}</td>
          <td class="px-3 py-2 font-bold">${fmtMoney(t.movement_out)}</td>
          <td class="px-3 py-2 font-bold">${fmtMoney(t.payout_out)}</td>
          <td class="px-3 py-2 font-bold">${fmtMoney(t.expected_close)}</td>
          <td class="px-3 py-2 font-bold ${totalVarClass}">${fmtMoney(t.variance)}</td>
        </tr>
      `;
    }).join('') : '<tr><td class="px-3 py-2 text-gray-600" colspan="9">No drawer activity in range.</td></tr>';
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

function onReportDetailToggle(ev) {
  const btn = ev?.target?.closest?.('[data-detail-toggle]');
  if (!btn) return;
  const id = btn.getAttribute('data-detail-toggle');
  if (!id) return;
  const row = document.getElementById(id);
  if (!row) return;
  const isOpen = row.style.display !== 'none';
  row.style.display = isOpen ? 'none' : 'table-row';
  btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
  btn.textContent = isOpen ? 'Show Details' : 'Hide Details';
}

function buildDailyDetailMap(data) {
  const out = new Map();
  const tz = data?.range?.timezone || undefined;
  const activity = data?.activity || {};
  const salesRows = Array.isArray(activity.cash_sales) ? activity.cash_sales : [];
  const ledgerRows = Array.isArray(activity.ledger_moves) ? activity.ledger_moves : [];

  const add = (drawer, date, section, record) => {
    const key = `${String(drawer || '')}::${String(date || '')}`;
    if (!out.has(key)) out.set(key, emptyDailyDetail());
    out.get(key)[section].push(record);
  };

  for (const s of salesRows) {
    const cashAmount = getCashSaleAmount(s);
    if (!(cashAmount > 0)) continue;
    add('1', dateKeyInTimezone(s.sale_ts, tz), 'salesIn', {
      ts: s.sale_ts,
      amount: cashAmount,
      label: 'POS cash sale',
      notes: s.payment_method || '',
    });
  }

  for (const l of ledgerRows) {
    const amount = Number(l.amount || 0);
    if (!(amount > 0)) continue;
    const dateKey = dateKeyInTimezone(l.created_at, tz);
    const fromDrawer = String(l.from_location || '').match(/^Drawer\s+(\d+)$/i)?.[1] || null;
    const toDrawer = String(l.to_location || '').match(/^Drawer\s+(\d+)$/i)?.[1] || null;

    if (toDrawer) {
      add(toDrawer, dateKey, 'movesIn', {
        ts: l.created_at,
        amount,
        label: `From ${String(l.from_location || 'Unknown')}`,
        notes: l.notes || '',
      });
    }
    if (fromDrawer) {
      if (/^purchase$/i.test(String(l.to_location || ''))) {
        add(fromDrawer, dateKey, 'payouts', {
          ts: l.created_at,
          amount,
          label: 'Payout',
          notes: l.notes || '',
        });
      } else {
        add(fromDrawer, dateKey, 'movesOut', {
          ts: l.created_at,
          amount,
          label: `To ${String(l.to_location || 'Unknown')}`,
          notes: l.notes || '',
        });
      }
    }
  }

  return out;
}

function emptyDailyDetail() {
  return { salesIn: [], movesIn: [], movesOut: [], payouts: [] };
}

function renderDailyDetails(detail, timezone) {
  return `
    <div class="report-detail-box">
      ${renderDetailSection('Sales In', detail.salesIn, timezone)}
      ${renderDetailSection('Moves In', detail.movesIn, timezone)}
      ${renderDetailSection('Moves Out', detail.movesOut, timezone)}
      ${renderDetailSection('Payouts', detail.payouts, timezone)}
    </div>
  `;
}

function renderDetailSection(title, rows, timezone) {
  if (!rows?.length) {
    return `
      <section class="report-detail-section">
        <h5 class="report-detail-heading">${esc(title)}</h5>
        <div class="report-detail-empty">No transactions.</div>
      </section>
    `;
  }
  const items = rows
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    .map((r) => `<li class="report-detail-item">
      <div class="report-detail-main">
        <span class="report-detail-datetime">${esc(fmtDateInTimezone(r.ts, timezone))}</span>
        <span class="report-detail-label">• ${esc(r.label || '')}</span>
        <span class="report-detail-amount">${fmtMoney(r.amount)}</span>
      </div>
      ${r.notes ? `<div class="report-detail-note">Note: ${esc(r.notes)}</div>` : ''}
    </li>`)
    .join('');
  return `
    <section class="report-detail-section">
      <h5 class="report-detail-heading">${esc(title)}</h5>
      <ul class="report-detail-list">${items}</ul>
    </section>
  `;
}

function getCashSaleAmount(saleRow) {
  const saleTotal = Number(saleRow?.total || 0);
  let cashAmt = parseCashFromParts((typeof saleRow?.items_json === 'object' && saleRow?.items_json) ? saleRow.items_json?.payment_parts : null);
  if (!(cashAmt > 0)) cashAmt = parseCashFromPaymentMethod(saleRow?.payment_method, saleTotal);
  return Number(cashAmt || 0);
}

function parseCashFromParts(paymentParts) {
  if (!Array.isArray(paymentParts)) return 0;
  let total = 0;
  for (const part of paymentParts) {
    const method = String(part?.method || '').toUpperCase();
    if (method !== 'CASH') continue;
    total += Number(part?.amount || 0);
  }
  return total;
}

function parseCashFromPaymentMethod(paymentMethod, saleTotal) {
  const pm = String(paymentMethod || '').toUpperCase();
  if (pm === 'CASH') return Number(saleTotal || 0);
  if (pm.includes('CASH')) {
    const m = pm.match(/CASH[:=]?\s*([\d.]+)/i);
    if (m) return Number(m[1] || 0);
  }
  return 0;
}

function getVarianceClass(amount, isTotal) {
  const x = Number(amount || 0);
  const strong = isTotal ? 'font-bold' : 'font-semibold';
  if (Math.abs(x) <= 0.009) return `report-variance-zero ${strong}`;
  if (x > 0) return `report-variance-over ${strong}`;
  return `report-variance-under ${strong}`;
}

function getDrawerRowClass(drawer) {
  return String(drawer) === '1' ? 'report-drawer-1' : 'report-drawer-2';
}

function safeDomId(v) {
  return String(v || '').replace(/[^a-zA-Z0-9_-]/g, '-');
}

function esc(v) {
  return String(v || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function dateKeyInTimezone(ts, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  } catch {
    return String(ts || '').slice(0, 10);
  }
}

function fmtDateInTimezone(ts, timezone) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(ts));
  } catch {
    return fmtDate(ts);
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
    if (canLoadCashReportUi()) await loadCashReport();

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
    const drawer = els.drawer.value;
    const period = els.period.value;
    if(!drawer){ showToast('Choose a drawer first'); return; }
    if(!period){ showToast('Choose a period first'); return; }
    const body = {
      drawer, period,
      pennies: val('pennies'),
      nickels: val('nickels'),
      dimes: val('dimes'),
      quarters: val('quarters'),
      halfdollars: val('halfdollars'),
      penny_rolls: val('penny_rolls'),
      nickel_rolls: val('nickel_rolls'),
      dime_rolls: val('dime_rolls'),
      quarter_rolls: val('quarter_rolls'),
      halfdollar_rolls: val('halfdollar_rolls'),
      dollarcoins: val('dollarcoins'),
      largedollarcoins: val('largedollarcoins'),
      smalldollar_rolls: val('smalldollar_rolls'),
      largedollar_rolls: val('largedollar_rolls'),
      ones: val('ones'),
      twos: val('twos'),
      fives: val('fives'),
      tens: val('tens'),
      twenties: val('twenties'),
      fifties: val('fifties'),
      hundreds: val('hundreds'),
      notes: els.notes.value || null
    };
    els.btnSave.disabled = true;
    els.status.textContent = 'Saving…';
    const resp = await api('/api/cash-drawer/save', { method:'POST', body });
    showToast('Saved');
    els.status.textContent = `Saved (${resp.count_id})`;
    // Refresh banner/status after save
    await loadToday();
    if (canLoadCashReportUi()) await loadCashReport();
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
    els.btnSave.disabled = !hasDrawerSelection() || !els.period.value;
  }
}
