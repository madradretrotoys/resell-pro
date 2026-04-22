import { api } from '/assets/js/api.js';

let els = {};
let editing = null;
let users = [];
let drawers = [];
let schedules = [];

export async function init() {
  bind();
  wire();
  initPatternDefaults();
  await Promise.all([loadUsers(), loadDrawers(), loadSchedules()]);
}

export function destroy() {}

function bind() {
  const ids = [
    'sch-banner','sch-form-title','sch-user','sch-start','sch-end','sch-break','sch-status','sch-drawer','sch-notes','sch-save','sch-cancel','sch-body','sch-summary-body',
    'sch-pattern-week-start','sch-pattern-start-time','sch-pattern-end-time','sch-generate-pattern','sch-pattern-days'
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

function wire() {
  els['sch-save']?.addEventListener('click', onSave);
  els['sch-cancel']?.addEventListener('click', clearForm);
  els['sch-generate-pattern']?.addEventListener('click', onGeneratePattern);
}

function banner(message, tone = 'info') {
  const el = els['sch-banner'];
  if (!el) return;
  el.textContent = message;
  el.className = `banner ${tone}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
}

function initPatternDefaults() {
  const now = new Date();
  const day = now.getDay();
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - day);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;
  if (els['sch-pattern-week-start']) els['sch-pattern-week-start'].value = ymd;
  const checks = els['sch-pattern-days']?.querySelectorAll('input[type="checkbox"]') || [];
  checks.forEach((c) => {
    const v = Number(c.value);
    c.checked = v >= 1 && v <= 5;
  });
}

function clearForm() {
  editing = null;
  if (els['sch-form-title']) els['sch-form-title'].textContent = 'Create Shift';
  if (els['sch-cancel']) els['sch-cancel'].hidden = true;
  if (els['sch-user']) els['sch-user'].value = users[0]?.user_id || '';
  if (els['sch-start']) els['sch-start'].value = '';
  if (els['sch-end']) els['sch-end'].value = '';
  if (els['sch-break']) els['sch-break'].value = '0';
  if (els['sch-status']) els['sch-status'].value = 'draft';
  if (els['sch-drawer']) els['sch-drawer'].value = '';
  if (els['sch-notes']) els['sch-notes'].value = '';
}

async function loadUsers() {
  const resp = await api('/api/settings/users/list');
  users = Array.isArray(resp?.users) ? resp.users.filter((u) => u?.active !== false) : [];
  const sel = els['sch-user'];
  if (!sel) return;
  sel.innerHTML = users.map((u) => `<option value="${u.user_id}">${esc(u.name || u.login_id || u.email || u.user_id)}</option>`).join('');
}

async function loadDrawers() {
  const resp = await api('/api/settings/drawers/list');
  drawers = Array.isArray(resp?.drawers) ? resp.drawers.filter((d) => d?.is_active !== false) : [];
  const sel = els['sch-drawer'];
  if (!sel) return;
  sel.innerHTML = `<option value="">None</option>` + drawers.map((d) => `<option value="${d.drawer_id}">${esc(d.drawer_name)}</option>`).join('');
}

async function loadSchedules() {
  try {
    const resp = await api('/api/settings/employee-schedules/list');
    schedules = Array.isArray(resp?.rows) ? resp.rows : [];
    renderRows();
  } catch {
    banner('Failed to load schedules.', 'error');
  }
}

function renderRows() {
  const body = els['sch-body'];
  if (!body) return;
  body.innerHTML = schedules.map((r) => `
    <tr>
      <td>${esc(r.user_name || r.user_login_id || r.user_id)}</td>
      <td>${fmtDate(r.shift_start_at)}</td>
      <td>${fmtDate(r.shift_end_at)}</td>
      <td>${Number(r.break_minutes || 0)}</td>
      <td>${fmtHours(rowPaidHours(r))}</td>
      <td>${esc(r.status || '')}</td>
      <td>${esc(r.preferred_drawer_name || '')}</td>
      <td>${esc(r.notes || '')}</td>
      <td>
        <div style="display:flex; gap:6px;">
          <button class="btn btn--neutral btn--sm" data-edit="${r.schedule_id}">Edit</button>
          <button class="btn btn--neutral btn--sm" data-del="${r.schedule_id}">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = schedules.find((x) => x.schedule_id === btn.getAttribute('data-edit'));
      if (!row) return;
      editing = row.schedule_id;
      if (els['sch-form-title']) els['sch-form-title'].textContent = 'Edit Shift';
      if (els['sch-cancel']) els['sch-cancel'].hidden = false;
      if (els['sch-user']) els['sch-user'].value = row.user_id || '';
      if (els['sch-start']) els['sch-start'].value = isoToLocalInput(row.shift_start_at);
      if (els['sch-end']) els['sch-end'].value = isoToLocalInput(row.shift_end_at);
      if (els['sch-break']) els['sch-break'].value = String(Number(row.break_minutes || 0));
      if (els['sch-status']) els['sch-status'].value = row.status || 'draft';
      if (els['sch-drawer']) els['sch-drawer'].value = row.preferred_drawer_id || '';
      if (els['sch-notes']) els['sch-notes'].value = row.notes || '';
    });
  });

  body.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/settings/employee-schedules/delete', {
          method: 'POST',
          body: { schedule_id: btn.getAttribute('data-del') },
        });
        banner('Shift deleted.', 'success');
        await loadSchedules();
      } catch {
        banner('Failed to delete shift.', 'error');
      }
    });
  });

  renderSummary();
}

function renderSummary() {
  const body = els['sch-summary-body'];
  if (!body) return;

  const totals = new Map();
  for (const r of schedules) {
    const key = String(r.user_id || '');
    const name = String(r.user_name || r.user_login_id || r.user_id || 'Unknown');
    const paid = rowPaidHours(r);
    if (!totals.has(key)) totals.set(key, { name, hours: 0 });
    totals.get(key).hours += paid;
  }

  const rows = Array.from(totals.values()).sort((a, b) => a.name.localeCompare(b.name));
  body.innerHTML = rows.length ? rows.map((r) => {
    const overtime = r.hours > 40;
    return `
      <tr>
        <td>${esc(r.name)}</td>
        <td>${fmtHours(r.hours)}</td>
        <td>${overtime ? 'Yes' : 'No'}</td>
      </tr>
    `;
  }).join('') : `<tr><td colspan="3">No shifts in selected range.</td></tr>`;
}

async function onSave() {
  const body = {
    schedule_id: editing,
    user_id: els['sch-user']?.value || '',
    shift_start_at: localInputToIso(els['sch-start']?.value || ''),
    shift_end_at: localInputToIso(els['sch-end']?.value || ''),
    break_minutes: Number(els['sch-break']?.value || 0),
    status: els['sch-status']?.value || 'draft',
    preferred_drawer_id: els['sch-drawer']?.value || null,
    notes: (els['sch-notes']?.value || '').trim() || null,
  };

  if (!body.shift_start_at || !body.shift_end_at) {
    banner('Start and end time are required.', 'error');
    return;
  }

  const start = new Date(body.shift_start_at);
  const end = new Date(body.shift_end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    banner('Start and end must be valid date/time values.', 'error');
    return;
  }
  if (end.getTime() <= start.getTime()) {
    banner('End must be after start.', 'error');
    return;
  }
  const durationMinutes = (end.getTime() - start.getTime()) / 60000;
  if (durationMinutes > 24 * 60) {
    banner('For now, each schedule row must be a single-day shift (24h max).', 'error');
    return;
  }
  if (Number(body.break_minutes || 0) > durationMinutes) {
    banner('Lunch minutes cannot exceed shift length.', 'error');
    return;
  }

  try {
    await api('/api/settings/employee-schedules/save', { method: 'POST', body });
    banner(editing ? 'Shift updated.' : 'Shift created.', 'success');
    clearForm();
    await loadSchedules();
  } catch (e) {
    const msg = e?.data?.error || 'save_failed';
    if (msg === 'overlap') {
      banner('Shift overlaps an existing shift for this employee.', 'error');
      return;
    }
    if (msg === 'shift_too_long_single_day_only') {
      banner('Shift is too long. Please create one row per day.', 'error');
      return;
    }
    if (msg === 'end_must_be_after_start') {
      banner('End must be after start.', 'error');
      return;
    }
    if (msg === 'lunch_exceeds_shift') {
      banner('Lunch minutes cannot exceed shift length.', 'error');
      return;
    }
    banner(`Failed to save shift (${msg}).`, 'error');
  }
}

async function onGeneratePattern() {
  const user_id = els['sch-user']?.value || '';
  const weekStart = String(els['sch-pattern-week-start']?.value || '');
  const startTime = String(els['sch-pattern-start-time']?.value || '');
  const endTime = String(els['sch-pattern-end-time']?.value || '');
  const lunch = Number(els['sch-break']?.value || 0);
  const status = els['sch-status']?.value || 'draft';
  const preferred_drawer_id = els['sch-drawer']?.value || null;
  const notes = (els['sch-notes']?.value || '').trim() || null;
  const checkedDays = Array.from(els['sch-pattern-days']?.querySelectorAll('input[type=\"checkbox\"]:checked') || [])
    .map((el) => Number(el.value))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6);

  if (!user_id) return banner('Select an employee.', 'error');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return banner('Choose a valid week start date.', 'error');
  if (!startTime || !endTime) return banner('Pattern start and end time are required.', 'error');
  if (!checkedDays.length) return banner('Select at least one weekday.', 'error');

  const [sh, sm] = startTime.split(':').map((x) => Number(x));
  const [eh, em] = endTime.split(':').map((x) => Number(x));
  if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return banner('Invalid pattern time.', 'error');
  if (eh * 60 + em <= sh * 60 + sm) return banner('Pattern end must be after start.', 'error');

  let created = 0;
  let failed = 0;
  for (const day of checkedDays) {
    const base = new Date(`${weekStart}T00:00:00`);
    base.setDate(base.getDate() + day);
    const start = new Date(base);
    start.setHours(sh, sm, 0, 0);
    const end = new Date(base);
    end.setHours(eh, em, 0, 0);

    try {
      await api('/api/settings/employee-schedules/save', {
        method: 'POST',
        body: {
          user_id,
          shift_start_at: start.toISOString(),
          shift_end_at: end.toISOString(),
          break_minutes: lunch,
          status,
          preferred_drawer_id,
          notes,
        },
      });
      created += 1;
    } catch {
      failed += 1;
    }
  }

  if (created) {
    banner(`Generated ${created} shift(s).${failed ? ` ${failed} failed (likely overlap).` : ''}`, failed ? 'info' : 'success');
    await loadSchedules();
  } else {
    banner('No shifts were generated.', 'error');
  }
}

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function fmtDate(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function rowPaidHours(row) {
  const start = new Date(row?.shift_start_at || '');
  const end = new Date(row?.shift_end_at || '');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const totalMs = end.getTime() - start.getTime();
  if (totalMs <= 0) return 0;
  const lunchMinutes = Math.max(0, Number(row?.break_minutes || 0));
  const paidMs = Math.max(0, totalMs - lunchMinutes * 60_000);
  return paidMs / 3_600_000;
}

function fmtHours(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

function esc(v) {
  return String(v || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
