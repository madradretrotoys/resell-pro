import { api } from '/assets/js/api.js';
import { showToast } from '/assets/js/ui.js';

let els = {};
let state = {
  actor: null,
  todayEntry: null,
  periodEntries: [],
  canEdit: false,
};

export async function init({ container }) {
  bind(container);
  wire();
  setBanner();
  await loadMe();
  await loadReport();
}

function bind(container) {
  els = {
    today: container.querySelector('#today'),
    todayStatus: container.querySelector('#todayStatus'),
    todayTimes: container.querySelector('#todayTimes'),
    btnClockIn: container.querySelector('#btnClockIn'),
    btnLunchOut: container.querySelector('#btnLunchOut'),
    btnLunchIn: container.querySelector('#btnLunchIn'),
    btnClockOut: container.querySelector('#btnClockOut'),
    myTable: container.querySelector('#myTable'),
    reportFrom: container.querySelector('#reportFrom'),
    reportTo: container.querySelector('#reportTo'),
    btnReportLoad: container.querySelector('#btnReportLoad'),
    reportTotal: container.querySelector('#reportTotal'),
    reportTable: container.querySelector('#reportTable'),
    adminCard: container.querySelector('#adminCard'),
    adminDate: container.querySelector('#adminDate'),
    btnAdminLoad: container.querySelector('#btnAdminLoad'),
    adminTable: container.querySelector('#adminTable'),
    busy: container.querySelector('#busy'),
    logs: container.querySelector('#logs'),
  };
}

function wire() {
  els.btnClockIn?.addEventListener('click', () => punch('clock_in'));
  els.btnLunchOut?.addEventListener('click', () => punch('lunch_out'));
  els.btnLunchIn?.addEventListener('click', () => punch('lunch_in'));
  els.btnClockOut?.addEventListener('click', () => punch('clock_out'));
  els.btnReportLoad?.addEventListener('click', loadReport);
  els.btnAdminLoad?.addEventListener('click', loadAdmin);
}

function setBanner() {
  const now = new Date();
  if (els.today) {
    els.today.textContent = `Today is ${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`;
  }
  if (els.adminDate) els.adminDate.value = isoDate(now);
  if (els.reportTo) els.reportTo.value = isoDate(now);
  if (els.reportFrom) {
    const from = new Date(now);
    from.setDate(now.getDate() - 13);
    els.reportFrom.value = isoDate(from);
  }
}

async function loadMe() {
  setBusy(true);
  try {
    const data = await api('/api/timesheet/me');
    state.actor = data.actor || null;
    state.todayEntry = data.today || null;
    state.periodEntries = data.period_entries || [];
    state.canEdit = !!data?.actor?.can_edit_timesheet;

    renderToday();
    renderMyTable();

    if (state.canEdit) {
      els.adminCard.style.display = '';
      await loadAdmin();
    } else {
      els.adminCard.style.display = 'none';
    }
  } catch (e) {
    showToast('Unable to load timesheet.');
    log(`loadMe failed: ${e?.data?.error || e?.message || e}`);
  } finally {
    setBusy(false);
  }
}

async function punch(action) {
  setBusy(true);
  try {
    await api('/api/timesheet/punch', {
      method: 'POST',
      body: { action },
    });
    await loadMe();
    await loadReport();
    showToast('Time updated.');
  } catch (e) {
    showToast(e?.data?.error ? `Unable: ${e.data.error}` : 'Unable to save time entry.');
    log(`punch failed (${action}): ${e?.data?.error || e?.message || e}`);
  } finally {
    setBusy(false);

    renderToday();
    renderMyTable();

    if (state.canEdit) {
      els.adminCard.style.display = '';
      await loadAdmin();
    } else {
      els.adminCard.style.display = 'none';
    }
  } catch (e) {
    showToast('Unable to load timesheet.');
    log(`loadMe failed: ${e?.data?.error || e?.message || e}`);
  } finally {
    setBusy(false);
  }
}

async function punch(action) {
  setBusy(true);
  try {
    const res = await api('/api/timesheet/punch', {
      method: 'POST',
      body: { action },
    });
    state.todayEntry = res.entry || null;
    await loadMe();
    showToast('Time updated.');
  } catch (e) {
    showToast(e?.data?.error ? `Unable: ${e.data.error}` : 'Unable to save time entry.');
    log(`punch failed (${action}): ${e?.data?.error || e?.message || e}`);
  } finally {
    setBusy(false);
  }
}

function renderToday() {
  const e = state.todayEntry;
  const status = e?.status || 'Not started';
  els.todayStatus.textContent = status;

  els.todayTimes.textContent = [
    `Clock In: ${fmt(e?.clock_in)}`,
    `Lunch Out: ${fmt(e?.lunch_out)}`,
    `Lunch In: ${fmt(e?.lunch_in)}`,
    `Clock Out: ${fmt(e?.clock_out)}`,
  ].join(' • ');

  els.btnClockIn.disabled = !!e?.clock_in;
  els.btnLunchOut.disabled = !e?.clock_in || !!e?.lunch_out;
  els.btnLunchIn.disabled = !e?.lunch_out || !!e?.lunch_in;
  els.btnClockOut.disabled = !e?.clock_in || !!e?.clock_out;
}

function renderMyTable() {
  const rows = state.periodEntries || [];
  if (!rows.length) {
    els.myTable.innerHTML = '<tbody><tr><td class="muted">No entries yet.</td></tr></tbody>';
    return;
  }
}

function renderToday() {
  const e = state.todayEntry;
  const status = e?.status || 'Not started';
  els.todayStatus.textContent = status;

  els.todayTimes.textContent = [
    `Clock In: ${fmt(e?.clock_in)}`,
    `Lunch Out: ${fmt(e?.lunch_out)}`,
    `Lunch In: ${fmt(e?.lunch_in)}`,
    `Clock Out: ${fmt(e?.clock_out)}`,
    `Total: ${fmtHours(e?.total_hours)}`,
  ].join(' • ');

  els.btnClockIn.disabled = !!e?.clock_in;
  els.btnLunchOut.disabled = !e?.clock_in || !!e?.lunch_out;
  els.btnLunchIn.disabled = !e?.lunch_out || !!e?.lunch_in;
  els.btnClockOut.disabled = !e?.clock_in || !!e?.clock_out;
}

function renderMyTable() {
  const rows = state.periodEntries || [];
  if (!rows.length) {
    els.myTable.innerHTML = '<tbody><tr><td class="muted">No entries yet.</td></tr></tbody>';
    return;
  }

  els.myTable.innerHTML = `
    <thead>
      <tr>
        <th>Date</th><th>Clock In</th><th>Lunch Out</th><th>Lunch In</th><th>Clock Out</th><th>Total Hours</th><th>Status</th>
  els.myTable.innerHTML = `
    <thead>
      <tr>
        <th>Date</th><th>Clock In</th><th>Lunch Out</th><th>Lunch In</th><th>Clock Out</th><th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r) => `
        <tr>
          <td>${fmtDate(r.clock_in)}</td>
          <td>${fmt(r.clock_in)}</td>
          <td>${fmt(r.lunch_out)}</td>
          <td>${fmt(r.lunch_in)}</td>
          <td>${fmt(r.clock_out)}</td>
          <td>${fmtHours(r.total_hours)}</td>
          <td>${escapeHtml(r.status || '')}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

async function loadReport() {
  const from = els.reportFrom?.value;
  const to = els.reportTo?.value;
  if (!from || !to) return;

  setBusy(true);
  try {
    const data = await api(`/api/timesheet/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    renderReport(data.entries || [], data.grand_total_hours || 0);
  } catch (e) {
    showToast(e?.data?.error ? `Unable: ${e.data.error}` : 'Unable to run report.');
    log(`loadReport failed: ${e?.data?.error || e?.message || e}`);
  } finally {
    setBusy(false);
  }
}

function renderReport(rows, grandTotal) {
  els.reportTotal.textContent = `Grand Total Hours: ${fmtHours(grandTotal)}`;

  if (!rows.length) {
    els.reportTable.innerHTML = '<tbody><tr><td class="muted">No entries in selected date range.</td></tr></tbody>';
    return;
  }

  els.reportTable.innerHTML = `
    <thead>
      <tr>
        <th>Date</th><th>Clock In</th><th>Lunch Out</th><th>Lunch In</th><th>Clock Out</th><th>Total Hours</th><th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r) => `
        <tr>
          <td>${fmtDate(r.clock_in)}</td>
          <td>${fmt(r.clock_in)}</td>
          <td>${fmt(r.lunch_out)}</td>
          <td>${fmt(r.lunch_in)}</td>
          <td>${fmt(r.clock_out)}</td>
          <td>${fmtHours(r.total_hours)}</td>
          <td>${escapeHtml(r.status || '')}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

async function loadAdmin() {
  if (!state.canEdit) return;
  setBusy(true);
  try {
    const q = els.adminDate?.value ? `?date=${encodeURIComponent(els.adminDate.value)}` : '';
    const data = await api(`/api/timesheet/admin-list${q}`);
    renderAdminTable(data.entries || []);
  } catch (e) {
    showToast('Unable to load tenant entries.');
    log(`loadAdmin failed: ${e?.data?.error || e?.message || e}`);
  } finally {
    setBusy(false);
  }
}

function renderAdminTable(entries) {
  if (!entries.length) {
    els.adminTable.innerHTML = '<tbody><tr><td class="muted">No entries for selected date.</td></tr></tbody>';
    return;
  }

  els.adminTable.innerHTML = `
    <thead>
      <tr>
        <th>User</th><th>Login</th><th>Clock In</th><th>Lunch Out</th><th>Lunch In</th><th>Clock Out</th><th>Total Hours</th><th>Status</th><th>Action</th>
        <th>User</th><th>Login</th><th>Clock In</th><th>Lunch Out</th><th>Lunch In</th><th>Clock Out</th><th>Status</th><th>Action</th>
      </tr>
    </thead>
    <tbody>
      ${entries.map((e) => `
        <tr data-entry-id="${escapeHtml(e.entry_id)}">
          <td>${escapeHtml(e.user_name || '')}</td>
          <td>${escapeHtml(e.login_id || '')}</td>
          <td><input data-f="clock_in" type="datetime-local" value="${dtLocal(e.clock_in)}" /></td>
          <td><input data-f="lunch_out" type="datetime-local" value="${dtLocal(e.lunch_out)}" /></td>
          <td><input data-f="lunch_in" type="datetime-local" value="${dtLocal(e.lunch_in)}" /></td>
          <td><input data-f="clock_out" type="datetime-local" value="${dtLocal(e.clock_out)}" /></td>
          <td>${fmtHours(e.total_hours)}</td>
          <td>
            <select data-f="status">
              ${['open', 'complete', 'needsreview', ''].map((v) => `<option value="${v}" ${String(e.status || '') === v ? 'selected' : ''}>${v || '—'}</option>`).join('')}
            </select>
          </td>
          <td><button class="btn" data-save="${escapeHtml(e.entry_id)}">Save</button></td>
        </tr>
      `).join('')}
    </tbody>
  `;

  els.adminTable.querySelectorAll('[data-save]').forEach((btn) => {
    btn.addEventListener('click', () => saveAdminRow(btn.getAttribute('data-save')));
  });
}

async function saveAdminRow(entryId) {
  const row = els.adminTable.querySelector(`tr[data-entry-id="${CSS.escape(entryId)}"]`);
  if (!row) return;

  const payload = {
    entry_id: entryId,
    clock_in: fromLocal(row.querySelector('[data-f="clock_in"]')?.value),
    lunch_out: fromLocal(row.querySelector('[data-f="lunch_out"]')?.value),
    lunch_in: fromLocal(row.querySelector('[data-f="lunch_in"]')?.value),
    clock_out: fromLocal(row.querySelector('[data-f="clock_out"]')?.value),
    status: row.querySelector('[data-f="status"]')?.value || null,
    notes: null,
  };

  setBusy(true);
  try {
    await api('/api/timesheet/admin-edit', { method: 'POST', body: payload });
    showToast('Entry updated.');
    await loadAdmin();
    await loadReport();
  } catch (e) {
    showToast(e?.data?.error ? `Unable: ${e.data.error}` : 'Unable to update entry.');
    log(`saveAdminRow failed: ${e?.data?.error || e?.message || e}`);
  } finally {
    setBusy(false);
  }
}

function setBusy(on) { els.busy?.classList.toggle('show', !!on); }
function fmt(v) { return v ? new Date(v).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'; }
function fmtDate(v) { return v ? new Date(v).toLocaleDateString() : '—'; }
function fmtHours(v) { return Number(v || 0).toFixed(2); }
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function dtLocal(v) { if (!v) return ''; const d = new Date(v); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function fromLocal(v) { return v ? new Date(v).toISOString() : null; }
function log(msg) { if (els.logs) els.logs.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n${els.logs.textContent || ''}`.trim(); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
