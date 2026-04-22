import { api } from '/assets/js/api.js';
import { showToast } from '/assets/js/ui.js';

let els = {};
let state = {
  actor: null,
  todayEntry: null,
  periodEntries: [],
  teamStatuses: [],
  cashSummary: null,
  weekSchedule: null,
  drawerStatus: null,
  drawerPrompt: null,
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
    weeklyScheduleCard: container.querySelector('#weeklyScheduleCard'),
    weeklyScheduleTitle: container.querySelector('#weeklyScheduleTitle'),
    weeklyScheduleTable: container.querySelector('#weeklyScheduleTable'),
    drawerPromptCard: container.querySelector('#drawerPromptCard'),
    drawerPromptLine: container.querySelector('#drawerPromptLine'),
    drawerPromptCta: container.querySelector('#drawerPromptCta'),
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
    state.weekSchedule = me?.week_schedule || null;
    state.drawerStatus = me?.drawer_status || null;
    state.drawerPrompt = me?.drawer_prompt || null;

    renderMyStatus();
    renderDrawerPrompt();
    renderWeekSchedule();
    if (state.actor?.can_cash_edit) {
      await loadCashMovementSummary();
    } else if (els.cashMovementCard) {
      els.cashMovementCard.style.display = 'none';
    }

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
  const endDate = state.cashSummary?.range?.end_date || null;
  const byDrawer = Array.isArray(state.cashSummary?.daily_by_drawer) ? state.cashSummary.daily_by_drawer : [];

  if (els.cashMovementSubtitle) {
    const start = state.cashSummary?.range?.start_date;
    const end = state.cashSummary?.range?.end_date;
    if (start && end) {
      els.cashMovementSubtitle.textContent = start === end
        ? `Summary for ${start}.`
        : `Summary for ${start} to ${end}.`;
    }
  }

  const drawerRows = byDrawer
    .map((group) => {
      const days = Array.isArray(group?.days) ? group.days : [];
      const dayRow = (endDate ? days.find((d) => String(d?.date || '') === String(endDate)) : null) || days[0] || null;
      if (!dayRow) return '';

      const variance = Number(dayRow.variance || 0);
      const varianceColor = Math.abs(variance) <= 0.009 ? '#166534' : '#b91c1c';

      return `
        <tr>
          <td>${escapeHtml(String(group?.drawer || '—'))}</td>
          <td>${fmtMoney(dayRow.open_total)}</td>
          <td>${fmtMoney(dayRow.close_total)}</td>
          <td>${fmtMoney(dayRow.sales_in)}</td>
          <td>${fmtMoney(dayRow.movement_in)}</td>
          <td>${fmtMoney(dayRow.movement_out)}</td>
          <td>${fmtMoney(dayRow.payout_out)}</td>
          <td>${fmtMoney(dayRow.expected_close)}</td>
          <td style="color:${varianceColor}; font-weight:700;">${fmtMoney(variance)}</td>
        </tr>
      `;
    })
    .filter(Boolean)
    .join('');

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

    <div class="table-wrap" style="margin-top:12px;">
      <table class="table">
        <thead>
          <tr>
            <th>Drawer</th>
            <th>Open</th>
            <th>Close</th>
            <th>Sales In</th>
            <th>Moves In</th>
            <th>Moves Out</th>
            <th>Payouts</th>
            <th>Expected Close</th>
            <th>Variance</th>
          </tr>
        </thead>
        <tbody>
          ${drawerRows || '<tr><td colspan="9" class="muted">No drawer data found for today.</td></tr>'}
        </tbody>
      </table>
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
    if (els.dashIntro) {
      els.dashIntro.textContent = '';
      els.dashIntro.style.display = 'none';
    }
    return;
  }

  if (els.dashIntro) els.dashIntro.style.display = '';

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

function renderWeekSchedule() {
  if (!els.weeklyScheduleCard || !els.weeklyScheduleTable || !els.weeklyScheduleTitle) return;
  const schedule = state.weekSchedule;
  if (!schedule || !Array.isArray(schedule.rows) || !schedule.rows.length) {
    els.weeklyScheduleCard.style.display = 'none';
    return;
  }

  els.weeklyScheduleCard.style.display = '';
  els.weeklyScheduleTitle.textContent = schedule.title || 'Weekly Schedule';

  els.weeklyScheduleTable.innerHTML = `
    <thead>
      <tr>
        <th>Day</th>
        <th>Start</th>
        <th>End</th>
        <th>Lunch (min)</th>
      </tr>
    </thead>
    <tbody>
      ${schedule.rows.map((row) => {
        const day = row?.business_date ? new Date(`${String(row.business_date).slice(0, 10)}T00:00:00`) : null;
        const dayLabel = day ? day.toLocaleDateString([], { weekday: 'long' }) : '—';
        return `
          <tr>
            <td>${escapeHtml(dayLabel)}</td>
            <td>${escapeHtml(fmtTime(row?.shift_start_at))}</td>
            <td>${escapeHtml(fmtTime(row?.shift_end_at))}</td>
            <td>${escapeHtml(String(Number(row?.break_minutes || 0)))}</td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;
}

function renderDrawerPrompt() {
  if (!els.drawerPromptCard || !els.drawerPromptLine || !els.drawerPromptCta) return;
  const status = state.drawerStatus;
  const prompt = state.drawerPrompt;
  if (!status && !prompt) {
    els.drawerPromptCard.style.display = 'none';
    return;
  }

  els.drawerPromptCard.style.display = '';
  const drawerName = status?.drawer_name || prompt?.drawer_name || '';
  const labelPrefix = drawerName ? `${drawerName}: ` : '';
  const openText = status ? `Open ${status.has_open ? '✅ Complete' : '❌ Missing'}` : '';
  const closeText = status ? `Close ${status.has_close ? '✅ Complete' : '❌ Missing'}` : '';
  const statusText = status ? `${openText} · ${closeText}` : '';
  const message = prompt?.message || statusText || 'Drawer count reminder.';
  els.drawerPromptLine.textContent = `${labelPrefix}${message}`;

  if (prompt) {
    els.drawerPromptCta.style.display = '';
    els.drawerPromptCta.textContent = prompt.cta_label || 'Open Cash Tracking';
  } else {
    els.drawerPromptCta.style.display = 'none';
  }
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
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
