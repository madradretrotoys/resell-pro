// screens/timesheet.js
import { api } from '/assets/js/api.js';
import { showToast } from '/assets/js/ui.js';

let els = {};
let sessionUser = null;

export async function init({ container, session }) {
  sessionUser = session?.user || null;
  bind(container);
  wire();
  setTodayBanner();
  renderPayPeriodTable();
  await checkApiHealth();
}

function bind(container) {
  els = {
    root: container,
    today: container.querySelector('#today'),
    mgrBox: container.querySelector('#mgrBox'),
    mgrLogin: container.querySelector('#mgrLogin'),
    mgrDate: container.querySelector('#mgrDate'),
    mgrIn: container.querySelector('#mgrIn'),
    mgrLout: container.querySelector('#mgrLout'),
    mgrLin: container.querySelector('#mgrLin'),
    mgrOut: container.querySelector('#mgrOut'),
    mgrNote: container.querySelector('#mgrNote'),
    btnMgrSave: container.querySelector('#btnMgrSave'),
    periodTable: container.querySelector('#periodTable'),
    logs: container.querySelector('#logs'),
    busy: container.querySelector('#rpBusy'),
  };
}

function wire() {
  toggleManagerSection();

  if (els.btnMgrSave) {
    els.btnMgrSave.addEventListener('click', onManagerSave);
  }
}

function setTodayBanner() {
  if (!els.today) return;
  const now = new Date();
  els.today.textContent = `Today is ${now.toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })}.`;
}

function toggleManagerSection() {
  if (!els.mgrBox) return;

  // Support either role-based or permission-based user payloads.
  const role = String(sessionUser?.role || '').toLowerCase();
  const perms = sessionUser?.permissions || {};
  const canManage = role === 'manager' || role === 'admin' || !!perms?.can_settings;

  els.mgrBox.style.display = canManage ? '' : 'none';
}

function renderPayPeriodTable() {
  if (!els.periodTable) return;

  const start = getPayPeriodStart(new Date());
  const rows = [];

  for (let i = 0; i < 14; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    rows.push({
      date: d,
      clockIn: '—',
      lunchOut: '—',
      lunchIn: '—',
      clockOut: '—',
      total: '—',
      status: 'Open',
    });
  }

  els.periodTable.innerHTML = `
    <thead>
      <tr>
        <th>Date</th>
        <th>Clock In</th>
        <th>Lunch Out</th>
        <th>Lunch In</th>
        <th>Clock Out</th>
        <th>Total</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r) => `
        <tr>
          <td>${r.date.toLocaleDateString()}</td>
          <td>${r.clockIn}</td>
          <td>${r.lunchOut}</td>
          <td>${r.lunchIn}</td>
          <td>${r.clockOut}</td>
          <td>${r.total}</td>
          <td><span class="pill">${r.status}</span></td>
        </tr>
      `).join('')}
    </tbody>
  `;

  log(`Rendered pay period starting ${start.toDateString()} (14 days).`);
}

function getPayPeriodStart(today) {
  // Biweekly period anchored to Monday, Jan 1, 2024.
  const anchor = new Date('2024-01-01T00:00:00');

  const current = new Date(today);
  const day = current.getDay();
  const diffToMonday = (day + 6) % 7;
  current.setDate(current.getDate() - diffToMonday);
  current.setHours(0, 0, 0, 0);

  const daysFromAnchor = Math.floor((current - anchor) / 86400000);
  const periodOffset = ((daysFromAnchor % 14) + 14) % 14;
  current.setDate(current.getDate() - periodOffset);

  return current;
}

async function checkApiHealth() {
  setBusy(true);
  try {
    await api('/api/ping', { method: 'GET' });
    log('API ping ok. Screen wiring is healthy.');
  } catch (err) {
    log(`API ping failed (non-blocking): ${err?.message || err}`);
  } finally {
    setBusy(false);
  }
}

function onManagerSave() {
  const payload = {
    login_id: (els.mgrLogin?.value || '').trim(),
    date: els.mgrDate?.value || '',
    clock_in: (els.mgrIn?.value || '').trim(),
    lunch_out: (els.mgrLout?.value || '').trim(),
    lunch_in: (els.mgrLin?.value || '').trim(),
    clock_out: (els.mgrOut?.value || '').trim(),
    note: (els.mgrNote?.value || '').trim(),
  };

  if (!payload.login_id || !payload.date) {
    showToast('Please provide Login ID and Date before saving.');
    return;
  }

  // Endpoint is not implemented in this repository yet.
  // Keep UX unblocked and log payload for next-step backend hookup.
  log(`Manager save draft: ${JSON.stringify(payload)}`);
  showToast('Manager save captured locally. API endpoint hookup is next.');
}

function setBusy(on) {
  if (!els.busy) return;
  els.busy.setAttribute('aria-hidden', on ? 'false' : 'true');
  els.busy.setAttribute('aria-busy', on ? 'true' : 'false');
}

function log(message) {
  if (!els.logs) return;
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${message}`;
  els.logs.textContent = `${line}\n${els.logs.textContent || ''}`.trim();
}
