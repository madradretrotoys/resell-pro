import { api } from '/assets/js/api.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let els = {};
let users = [];
let drawers = [];
let loadedRowsByDate = new Map();
let tenantLunchRules = { consecutiveHoursRequired: 0, defaultLunchMinutes: 0 };
let staticScheduleSet = false;

export async function init() {
  bind();
  wire();
  setWeekStartDateToTodayWeek();
  await Promise.all([loadUsers(), loadDrawers(), loadWeekConfig()]);
  buildWeekRows();
  await loadWeek();
}

export function destroy() {}

function bind() {
  const ids = [
    'sch-banner', 'sch-user', 'sch-clone-user', 'sch-week-start-day', 'sch-week-start-date', 'sch-load-week', 'sch-save-week', 'sch-clear-week', 'sch-clone-week', 'sch-static-toggle', 'sch-status', 'sch-drawer', 'sch-notes', 'sch-week-body', 'sch-week-total', 'sch-week-ot'
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

function wire() {
  els['sch-load-week']?.addEventListener('click', loadWeek);
  els['sch-save-week']?.addEventListener('click', saveWeek);
  els['sch-clear-week']?.addEventListener('click', () => {
    clearWeekInputs();
    banner('Cleared week builder.', 'info');
  });
  els['sch-clone-week']?.addEventListener('click', cloneWeekFromEmployee);
  els['sch-static-toggle']?.addEventListener('click', () => {
    staticScheduleSet = !staticScheduleSet;
    syncStaticScheduleToggle();
    banner(staticScheduleSet ? 'Schedule marked as set.' : 'Schedule marked as not set.', 'info');
  });
  els['sch-user']?.addEventListener('change', () => {
    clearWeekInputs();
    refreshCloneUserOptions();
    banner('Switched employee. Builder cleared for a fresh schedule.', 'info');
  });
  els['sch-week-start-day']?.addEventListener('change', async () => {
    await saveWeekConfig();
    setWeekStartDateToTodayWeek();
    buildWeekRows();
    refreshCloneUserOptions();
    await loadWeek();
  });
}

function banner(message, tone = 'info') {
  const el = els['sch-banner'];
  if (!el) return;
  el.textContent = message;
  el.className = `banner ${tone}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
}

function setWeekStartDateToTodayWeek() {
  const weekStartsOn = Number(els['sch-week-start-day']?.value || 0);
  const now = new Date();
  const day = now.getDay();
  const delta = (day - weekStartsOn + 7) % 7;
  const start = new Date(now);
  start.setDate(now.getDate() - delta);
  const ymd = localDateToYmd(start);
  if (els['sch-week-start-date']) els['sch-week-start-date'].value = ymd;
}

function localDateToYmd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function loadUsers() {
  const resp = await api('/api/settings/users/list');
  users = Array.isArray(resp?.users) ? resp.users.filter((u) => u?.active !== false) : [];
  const sel = els['sch-user'];
  if (!sel) return;
  sel.innerHTML = users.map((u) => `<option value="${u.user_id}">${esc(u.name || u.login_id || u.email || u.user_id)}</option>`).join('');
  refreshCloneUserOptions();
}

async function loadDrawers() {
  const resp = await api('/api/settings/drawers/list');
  drawers = Array.isArray(resp?.drawers) ? resp.drawers.filter((d) => d?.is_active !== false) : [];
  const sel = els['sch-drawer'];
  if (!sel) return;
  sel.innerHTML = `<option value="">None</option>` + drawers.map((d) => `<option value="${d.drawer_id}">${esc(d.drawer_name)}</option>`).join('');
}

async function loadWeekConfig() {
  try {
    const resp = await api('/api/settings/employee-schedules/week-config');
    const weekStartsOn = Number(resp?.week_starts_on ?? 0);
    if (els['sch-week-start-day']) els['sch-week-start-day'].value = String(weekStartsOn);
    tenantLunchRules = {
      consecutiveHoursRequired: Math.max(0, Number(resp?.consecutive_lunch_hours_required ?? 0) || 0),
      defaultLunchMinutes: Math.max(0, Number(resp?.default_lunch_minutes ?? 0) || 0),
    };
  } catch {
    // keep defaults
  }
}

async function saveWeekConfig() {
  const week_starts_on = Number(els['sch-week-start-day']?.value || 0);
  await api('/api/settings/employee-schedules/week-config', { method: 'POST', body: { week_starts_on } });
}

function buildWeekRows() {
  const weekStartsOn = Number(els['sch-week-start-day']?.value || 0);
  const body = els['sch-week-body'];
  if (!body) return;

  body.innerHTML = Array.from({ length: 7 }).map((_, offset) => {
    const dow = (weekStartsOn + offset) % 7;
    return `
      <tr data-dow="${dow}">
        <td>${DAY_NAMES[dow]}</td>
        <td><input type="checkbox" class="sch-work" /></td>
        <td><input type="time" class="input sch-start" disabled /></td>
        <td><input type="time" class="input sch-end" disabled /></td>
        <td><input type="number" min="0" step="1" class="input sch-lunch" value="0" disabled /></td>
        <td class="sch-paid">0.00</td>
        <td><button class="btn btn--neutral btn--sm sch-copy-prev">Copy Prev</button></td>
      </tr>
    `;
  }).join('');

  body.querySelectorAll('tr').forEach((tr, idx) => {
    const work = tr.querySelector('.sch-work');
    const start = tr.querySelector('.sch-start');
    const end = tr.querySelector('.sch-end');
    const lunch = tr.querySelector('.sch-lunch');

    work?.addEventListener('change', () => {
      const isWorking = !!work.checked;
      start.disabled = !isWorking;
      end.disabled = !isWorking;
      lunch.disabled = !isWorking;
      if (!isWorking) {
        start.value = '';
        end.value = '';
        lunch.value = '0';
      } else {
        maybeApplyDefaultLunch(tr);
      }
      recalcTotals();
    });

    start?.addEventListener('input', () => {
      maybeApplyDefaultLunch(tr);
      recalcTotals();
    });

    end?.addEventListener('input', () => {
      maybeApplyDefaultLunch(tr);
      recalcTotals();
    });

    lunch?.addEventListener('input', recalcTotals);

    tr.querySelector('.sch-copy-prev')?.addEventListener('click', () => {
      if (idx === 0) return;
      const rows = Array.from(body.querySelectorAll('tr'));
      let prev = null;
      for (let i = idx - 1; i >= 0; i -= 1) {
        const candidate = rows[i];
        const isWorking = !!candidate.querySelector('.sch-work')?.checked;
        const hasTimes = !!candidate.querySelector('.sch-start')?.value && !!candidate.querySelector('.sch-end')?.value;
        if (isWorking && hasTimes) {
          prev = candidate;
          break;
        }
      }
      if (!prev) return;
      tr.querySelector('.sch-work').checked = true;
      tr.querySelector('.sch-start').value = prev.querySelector('.sch-start').value;
      tr.querySelector('.sch-end').value = prev.querySelector('.sch-end').value;
      tr.querySelector('.sch-lunch').value = prev.querySelector('.sch-lunch').value;
      tr.querySelector('.sch-start').disabled = false;
      tr.querySelector('.sch-end').disabled = false;
      tr.querySelector('.sch-lunch').disabled = false;
      recalcTotals();
    });
  });
}

function weekDateForDow(targetDow) {
  const startYmd = els['sch-week-start-date']?.value;
  const base = new Date(`${startYmd}T00:00:00`);
  const weekStartsOn = Number(els['sch-week-start-day']?.value || 0);
  const offset = (targetDow - weekStartsOn + 7) % 7;
  base.setDate(base.getDate() + offset);
  return localDateToYmd(base);
}

async function loadWeek() {
  try {
    const user_id = els['sch-user']?.value || '';
    const week_start = els['sch-week-start-date']?.value || '';
    if (!user_id || !week_start) return;

    const rows = await fetchRowsForUser(user_id, week_start);

    applyRowsToWeek(rows);
  } catch {
    banner('Failed to load week.', 'error');
  }
}

async function saveWeek() {
  try {
    const user_id = els['sch-user']?.value || '';
    if (!user_id) return banner('Select an employee.', 'error');

    const status = els['sch-status']?.value || 'draft';
    const preferred_drawer_id = els['sch-drawer']?.value || null;
    const notes = (els['sch-notes']?.value || '').trim() || null;
    const static_schedule = !!staticScheduleSet;

    const week_start = els['sch-week-start-date']?.value || '';
    const existingRows = await fetchRowsForUser(user_id, week_start);
    const existingByDate = new Map();
    existingRows.forEach((r) => {
      const ymd = String(r.business_date || '').slice(0, 10);
      if (ymd) existingByDate.set(ymd, r);
    });

    const trs = Array.from(els['sch-week-body']?.querySelectorAll('tr') || []);
    let saved = 0;
    let deleted = 0;

    for (const tr of trs) {
      const dow = Number(tr.getAttribute('data-dow'));
      const ymd = weekDateForDow(dow);
      const existing = existingByDate.get(ymd);
      const work = !!tr.querySelector('.sch-work')?.checked;
      const startTime = tr.querySelector('.sch-start')?.value || '';
      const endTime = tr.querySelector('.sch-end')?.value || '';
      const lunch = Number(tr.querySelector('.sch-lunch')?.value || 0);

      if (!work) {
        if (existing?.schedule_id) {
          await api('/api/settings/employee-schedules/delete', { method: 'POST', body: { schedule_id: existing.schedule_id } });
          deleted += 1;
        }
        continue;
      }

      if (!startTime || !endTime) throw new Error(`Missing start/end for ${DAY_NAMES[dow]}`);
      const startIso = new Date(`${ymd}T${startTime}:00`).toISOString();
      const endIso = new Date(`${ymd}T${endTime}:00`).toISOString();

      await api('/api/settings/employee-schedules/save', {
        method: 'POST',
        body: {
          schedule_id: existing?.schedule_id || null,
          user_id,
          shift_start_at: startIso,
          shift_end_at: endIso,
          break_minutes: lunch,
          static_schedule,
          status,
          preferred_drawer_id,
          notes,
        },
      });
      saved += 1;
    }

    banner(`Saved week: ${saved} shift(s), ${deleted} removed.`, 'success');
    await loadWeek();
  } catch (e) {
    banner(`Failed to save week (${e?.message || 'error'}).`, 'error');
  }
}

async function cloneWeekFromEmployee() {
  try {
    const sourceUserId = els['sch-clone-user']?.value || '';
    const week_start = els['sch-week-start-date']?.value || '';
    if (!sourceUserId) return banner('Select an employee to clone from.', 'error');
    if (!week_start) return banner('Pick a week start date first.', 'error');

    const rows = await fetchRowsForUser(sourceUserId, week_start);
    applyRowsToWeek(rows, { preserveLoadedRows: true });
    banner('Week cloned into builder. Click Save Week to apply.', 'success');
  } catch {
    banner('Failed to clone week.', 'error');
  }
}

function clearWeekInputs() {
  loadedRowsByDate = new Map();
  staticScheduleSet = false;
  syncStaticScheduleToggle();
  const trs = els['sch-week-body']?.querySelectorAll('tr') || [];
  trs.forEach((tr) => {
    tr.querySelector('.sch-work').checked = false;
    tr.querySelector('.sch-start').value = '';
    tr.querySelector('.sch-end').value = '';
    tr.querySelector('.sch-lunch').value = '0';
    tr.querySelector('.sch-start').disabled = true;
    tr.querySelector('.sch-end').disabled = true;
    tr.querySelector('.sch-lunch').disabled = true;
  });
  if (els['sch-status']) els['sch-status'].value = 'draft';
  if (els['sch-drawer']) els['sch-drawer'].value = '';
  if (els['sch-notes']) els['sch-notes'].value = '';
  recalcTotals();
}

function refreshCloneUserOptions() {
  const sel = els['sch-clone-user'];
  if (!sel) return;
  const selectedUserId = els['sch-user']?.value || '';
  const cloneCandidates = users.filter((u) => u.user_id !== selectedUserId);
  sel.innerHTML = `<option value="">Choose employee…</option>` + cloneCandidates
    .map((u) => `<option value="${u.user_id}">${esc(u.name || u.login_id || u.email || u.user_id)}</option>`)
    .join('');
  const disabled = cloneCandidates.length === 0;
  sel.disabled = disabled;
  if (els['sch-clone-week']) els['sch-clone-week'].disabled = disabled;
}

async function fetchRowsForUser(userId, weekStart) {
  const q = new URLSearchParams({ week_start: weekStart });
  const resp = await api(`/api/settings/employee-schedules/list?${q.toString()}`);
  return Array.isArray(resp?.rows) ? resp.rows.filter((r) => r.user_id === userId) : [];
}

function applyRowsToWeek(rows, options = {}) {
  const { preserveLoadedRows = false } = options;
  if (!preserveLoadedRows) {
    loadedRowsByDate = new Map();
    rows.forEach((r) => {
      const ymd = String(r.business_date || '').slice(0, 10);
      if (ymd) loadedRowsByDate.set(ymd, r);
    });
  }

  const rowsByDate = new Map();
  rows.forEach((r) => {
    const ymd = String(r.business_date || '').slice(0, 10);
    if (ymd) rowsByDate.set(ymd, r);
  });

  const trs = els['sch-week-body']?.querySelectorAll('tr') || [];
  trs.forEach((tr) => {
    const dow = Number(tr.getAttribute('data-dow'));
    const ymd = weekDateForDow(dow);
    const row = rowsByDate.get(ymd);
    tr.querySelector('.sch-work').checked = !!row;
    tr.querySelector('.sch-start').value = row ? isoToLocalTime(row.shift_start_at) : '';
    tr.querySelector('.sch-end').value = row ? isoToLocalTime(row.shift_end_at) : '';
    tr.querySelector('.sch-lunch').value = row ? String(Number(row.break_minutes || 0)) : '0';
    tr.querySelector('.sch-start').disabled = !row;
    tr.querySelector('.sch-end').disabled = !row;
    tr.querySelector('.sch-lunch').disabled = !row;
  });

  staticScheduleSet = rows.some((r) => !!r.static_schedule);
  syncStaticScheduleToggle();
  recalcTotals();
}

function recalcTotals() {
  const trs = Array.from(els['sch-week-body']?.querySelectorAll('tr') || []);
  let total = 0;
  trs.forEach((tr) => {
    const work = !!tr.querySelector('.sch-work')?.checked;
    const s = tr.querySelector('.sch-start')?.value || '';
    const e = tr.querySelector('.sch-end')?.value || '';
    const lunch = Number(tr.querySelector('.sch-lunch')?.value || 0);
    let paid = 0;
    if (work && s && e) {
      const startM = timeToMinutes(s);
      const endM = timeToMinutes(e);
      if (endM > startM) {
        paid = Math.max(0, (endM - startM - Math.max(0, lunch)) / 60);
      }
    }
    tr.querySelector('.sch-paid').textContent = paid.toFixed(2);
    total += paid;
  });

  if (els['sch-week-total']) els['sch-week-total'].textContent = `Total Paid Hours: ${total.toFixed(2)}`;
  if (els['sch-week-ot']) els['sch-week-ot'].textContent = `Overtime Risk (40+): ${total > 40 ? 'Yes' : 'No'}`;
}

function maybeApplyDefaultLunch(tr) {
  const work = !!tr.querySelector('.sch-work')?.checked;
  const s = tr.querySelector('.sch-start')?.value || '';
  const e = tr.querySelector('.sch-end')?.value || '';
  if (!work || !s || !e) return;

  const startM = timeToMinutes(s);
  const endM = timeToMinutes(e);
  if (endM <= startM) return;

  const durationHours = (endM - startM) / 60;
  if (durationHours >= tenantLunchRules.consecutiveHoursRequired) {
    tr.querySelector('.sch-lunch').value = String(tenantLunchRules.defaultLunchMinutes);
  }
}

function syncStaticScheduleToggle() {
  const btn = els['sch-static-toggle'];
  if (!btn) return;
  btn.setAttribute('aria-pressed', staticScheduleSet ? 'true' : 'false');
  btn.textContent = staticScheduleSet ? 'Set ✓' : 'Set Schedule';
  btn.title = staticScheduleSet ? 'Click to unset schedule' : 'Click to mark this schedule as set';
  btn.classList.toggle('btn--primary', staticScheduleSet);
}

function isoToLocalTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeToMinutes(v) {
  const [h, m] = String(v || '').split(':').map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function esc(v) {
  return String(v || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
