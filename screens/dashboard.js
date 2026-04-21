import { api } from '/assets/js/api.js';
import { showToast } from '/assets/js/ui.js';

let els = {};
let state = {
  actor: null,
  todayEntry: null,
  periodEntries: [],
  teamStatuses: [],
  cashSummary: null,
};

export async function init({ container }) {
  bind(container);
  wire();
  await loadDashboard();
}

export function destroy() {}

function bind(container) {
  els = {
    dashIntro: container.querySelector('#dashIntro'),
    myStatusCard: container.querySelector('#myStatusCard'),
    myStatusLine: container.querySelector('#myStatusLine'),
    myLastClockOut: container.querySelector('#myLastClockOut'),
    btnDashboardClockIn: container.querySelector('#btnDashboardClockIn'),
    myPrompt: container.querySelector('#myPrompt'),
    cashMovementCard: container.querySelector('#cashMovementCard'),
    cashMovementSummary: container.querySelector('#cashMovementSummary'),
    cashMovementSubtitle: container.querySelector('#cashMovementSubtitle'),
    teamStatusCard: container.querySelector('#teamStatusCard'),
    teamStatusTable: container.querySelector('#teamStatusTable'),
  };
}

function wire() {
  els.btnDashboardClockIn?.addEventListener('click', onClockIn);
}

async function loadDashboard() {
  try {
    const me = await api('/api/timesheet/me');
    state.actor = me?.actor || null;
    state.todayEntry = me?.today || null;
    state.periodEntries = me?.period_entries || [];

    renderMyStatus();
    await loadCashMovementSummary();

    if (state.actor?.can_edit_timesheet) {
      els.teamStatusCard.style.display = '';
      await loadTeamStatus();
    } else {
      els.teamStatusCard.style.display = 'none';
    }
  } catch (e) {
    const err = String(e?.data?.error || '');
    if (err === 'timesheet_denied') {
      if (els.dashIntro) els.dashIntro.textContent = 'Timekeeping access is not enabled for your account.';
      if (els.myStatusLine) els.myStatusLine.textContent = 'Status unavailable.';
      if (els.btnDashboardClockIn) els.btnDashboardClockIn.disabled = true;
      return;
    }

    if (els.dashIntro) els.dashIntro.textContent = 'Unable to load your status right now.';
    if (els.myStatusLine) els.myStatusLine.textContent = 'Status unavailable.';
  }
}

async function loadCashMovementSummary() {
  if (!els.cashMovementCard || !els.cashMovementSummary) return;

  try {
    const data = await api('/api/cash-report/summary?preset=today');
    state.cashSummary = data || null;

    els.cashMovementCard.style.display = '';
    renderCashMovementSummary();
  } catch (e) {
    const err = String(e?.data?.error || '');
    if (err === 'forbidden' || err === 'unauthorized' || err === 'no_tenant') {
      els.cashMovementCard.style.display = 'none';
      return;
    }

    els.cashMovementCard.style.display = '';
    els.cashMovementSummary.textContent = 'Unable to load cash movement summary right now.';
  }
}

function renderCashMovementSummary() {
  const totals = state.cashSummary?.totals || {};
  const ledgerMoves = state.cashSummary?.activity?.ledger_moves || [];
  const movementIn = Number(totals.movement_in_total || 0);
  const movementOut = Number(totals.movement_out_total || 0);
  const payoutOut = Number(totals.payout_total || 0);
  const netMovement = movementIn - movementOut - payoutOut;

  if (els.cashMovementSubtitle) {
    const start = state.cashSummary?.range?.start_date;
    const end = state.cashSummary?.range?.end_date;
    if (start && end) {
      els.cashMovementSubtitle.textContent = start === end
        ? `Summary for ${start}.`
        : `Summary for ${start} to ${end}.`;
    }
  }

  els.cashMovementSummary.innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:10px;">
      <div class="tile" style="padding:10px;">
        <div class="muted">Movement In</div>
        <div style="font-weight:700; font-size:1.05rem;">${fmtMoney(movementIn)}</div>
      </div>
      <div class="tile" style="padding:10px;">
        <div class="muted">Movement Out</div>
        <div style="font-weight:700; font-size:1.05rem;">${fmtMoney(movementOut)}</div>
      </div>
      <div class="tile" style="padding:10px;">
        <div class="muted">Payouts</div>
        <div style="font-weight:700; font-size:1.05rem;">${fmtMoney(payoutOut)}</div>
      </div>
      <div class="tile" style="padding:10px;">
        <div class="muted">Net Movement</div>
        <div style="font-weight:700; font-size:1.05rem;">${fmtMoney(netMovement)}</div>
      </div>
      <div class="tile" style="padding:10px;">
        <div class="muted">Ledger Entries</div>
        <div style="font-weight:700; font-size:1.05rem;">${ledgerMoves.length}</div>
      </div>
    </div>
  `;
}

async function loadTeamStatus() {
  try {
    const data = await api('/api/timesheet/admin-status');
    state.teamStatuses = data?.statuses || [];
    renderTeamStatus();
  } catch {
    els.teamStatusTable.innerHTML = '<tbody><tr><td class="muted">Unable to load team status.</td></tr></tbody>';
  }
}

async function onClockIn() {
  const status = deriveStatus(state.todayEntry);
  if (status.key === 'clocked_in' || status.key === 'back_from_lunch') {
    showToast('You are already clocked in.');
    return;
  }
  try {
    const res = await api('/api/timesheet/punch', {
      method: 'POST',
      body: { action: 'clock_in' },
    });
    state.todayEntry = res?.entry || state.todayEntry;
    const at = fmtTime(state.todayEntry?.clock_in);
    showToast(`Clocked in${at !== '—' ? ` at ${at}` : ''}.`);
    await loadDashboard();
  } catch (e) {
    showToast(e?.data?.error ? `Unable: ${e.data.error}` : 'Unable to clock in.');
  }
}

function renderMyStatus() {
  const isClockinRequired = !!state.actor?.clockin_required;

  if (els.myStatusCard) els.myStatusCard.style.display = isClockinRequired ? '' : 'none';
  if (!isClockinRequired) {
    if (els.dashIntro) els.dashIntro.textContent = 'Your timekeeping status is up to date.';
    return;
  }

  const entry = state.todayEntry;
  const status = deriveStatus(entry);
  const needsPrompt = ['not_clocked_in', 'clocked_out', 'lunch_out'].includes(status.key);

  if (els.myStatusLine) els.myStatusLine.textContent = `Current status: ${status.label}`;
  if (els.dashIntro) {
    els.dashIntro.textContent = needsPrompt
      ? 'Please clock in to start your shift.'
      : 'Your timekeeping status is up to date.';
  }

  if (els.myPrompt) els.myPrompt.style.display = needsPrompt ? '' : 'none';
  if (els.btnDashboardClockIn) {
    const canQuickClockIn = ['not_clocked_in', 'clocked_out', 'lunch_out'].includes(status.key);
    els.btnDashboardClockIn.disabled = !canQuickClockIn;
  }

  const lastClockOut = getLastClockOut();
  if (els.myLastClockOut) {
    els.myLastClockOut.textContent = `Last clock out: ${lastClockOut ? fmtDateTime(lastClockOut) : '—'}`;
  }
}

function renderTeamStatus() {
  const rows = state.teamStatuses || [];
  if (!rows.length) {
    els.teamStatusTable.innerHTML = '<tbody><tr><td class="muted">No users found for this tenant.</td></tr></tbody>';
    return;
  }

  els.teamStatusTable.innerHTML = `
    <thead>
      <tr>
        <th>User</th>
        <th>Login</th>
        <th>Status</th>
        <th>Last Clock Out</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map((r) => `
          <tr>
            <td>${escapeHtml(r.user_name || '')}</td>
            <td>${escapeHtml(r.login_id || '')}</td>
            <td>${escapeHtml(r.status_label || 'Not clocked in')}</td>
            <td>${r.last_clock_out ? escapeHtml(fmtDateTime(r.last_clock_out)) : '—'}</td>
          </tr>
        `)
        .join('')}
    </tbody>
  `;
}

function getLastClockOut() {
  if (state.todayEntry?.clock_out) return state.todayEntry.clock_out;
  const prior = (state.periodEntries || []).find((row) => row?.clock_out);
  return prior?.clock_out || null;
}

function deriveStatus(entry) {
  if (!entry?.clock_in) return { key: 'not_clocked_in', label: 'Not clocked in' };
  if (entry.clock_out) return { key: 'clocked_out', label: `Clocked out for day at ${fmtTime(entry.clock_out)}` };
  if (entry.lunch_out && !entry.lunch_in) return { key: 'lunch_out', label: `Out to lunch since ${fmtTime(entry.lunch_out)}` };
  if (entry.lunch_in) return { key: 'back_from_lunch', label: `Clocked in from lunch at ${fmtTime(entry.lunch_in)}` };
  return { key: 'clocked_in', label: `Clocked in at ${fmtTime(entry.clock_in)}` };
}

function fmtTime(v) {
  if (!v) return '—';
  return new Date(v).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDateTime(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtMoney(v) {
  const n = Number(v || 0);
  return new Intl.NumberFormat([], { style: 'currency', currency: 'USD' }).format(n);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
