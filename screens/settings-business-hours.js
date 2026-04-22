import { api } from '/assets/js/api.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let els = {};

export async function init() {
  bind();
  wire();
  renderWeeklyDefaults();
  await loadAll();
}

export function destroy() {}

function bind() {
  const ids = [
    'bh-banner',
    'bh-weekly-body',
    'bh-save-weekly',
    'bh-ex-date',
    'bh-ex-closed',
    'bh-ex-open',
    'bh-ex-close',
    'bh-ex-reason',
    'bh-save-ex',
    'bh-ex-body',
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

function wire() {
  els['bh-save-weekly']?.addEventListener('click', saveWeekly);
  els['bh-save-ex']?.addEventListener('click', saveException);
}

function banner(message, tone = 'info') {
  const el = els['bh-banner'];
  if (!el) return;
  el.textContent = message;
  el.className = `banner ${tone}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
}

function renderWeeklyDefaults() {
  const body = els['bh-weekly-body'];
  if (!body) return;
  body.innerHTML = DAYS.map((name, i) => `
    <tr data-day="${i}">
      <td>${name}</td>
      <td><input type="checkbox" class="bh-day-closed" /></td>
      <td><input type="time" class="input bh-day-open" value="09:00" /></td>
      <td><input type="time" class="input bh-day-close" value="18:00" /></td>
    </tr>
  `).join('');
}

async function loadAll() {
  try {
    const resp = await api('/api/settings/business-hours/list');
    const weekly = Array.isArray(resp?.weekly) ? resp.weekly : [];
    const exceptions = Array.isArray(resp?.exceptions) ? resp.exceptions : [];
    hydrateWeekly(weekly);
    renderExceptions(exceptions);
  } catch {
    banner('Failed to load business hours.', 'error');
  }
}

function hydrateWeekly(rows) {
  const byDay = new Map();
  for (const r of rows) {
    if (r?.effective_start_date || r?.effective_end_date) continue;
    byDay.set(Number(r.day_of_week), r);
  }

  const trs = els['bh-weekly-body']?.querySelectorAll('tr[data-day]') || [];
  trs.forEach((tr) => {
    const day = Number(tr.getAttribute('data-day'));
    const row = byDay.get(day);
    if (!row) return;
    const closed = tr.querySelector('.bh-day-closed');
    const open = tr.querySelector('.bh-day-open');
    const close = tr.querySelector('.bh-day-close');
    if (closed) closed.checked = !!row.is_closed;
    if (open) open.value = String(row.open_time || '').slice(0, 5);
    if (close) close.value = String(row.close_time || '').slice(0, 5);
  });
}

async function saveWeekly() {
  try {
    const trs = els['bh-weekly-body']?.querySelectorAll('tr[data-day]') || [];
    const weekly = Array.from(trs).map((tr) => ({
      day_of_week: Number(tr.getAttribute('data-day')),
      is_closed: !!tr.querySelector('.bh-day-closed')?.checked,
      open_time: tr.querySelector('.bh-day-open')?.value || null,
      close_time: tr.querySelector('.bh-day-close')?.value || null,
    }));

    await api('/api/settings/business-hours/save-weekly', {
      method: 'POST',
      body: { weekly },
    });

    banner('Weekly hours saved.', 'success');
    await loadAll();
  } catch (e) {
    const msg = e?.data?.error || 'save_failed';
    banner(`Could not save weekly hours (${msg}).`, 'error');
  }
}

function renderExceptions(rows) {
  const body = els['bh-ex-body'];
  if (!body) return;
  body.innerHTML = rows.map((r) => {
    const status = r.is_closed ? 'Closed' : 'Open';
    const hours = r.is_closed ? '—' : `${String(r.open_time || '').slice(0,5)} - ${String(r.close_time || '').slice(0,5)}`;
    return `
      <tr>
        <td>${r.exception_date}</td>
        <td>${status}</td>
        <td>${hours}</td>
        <td>${r.reason || ''}</td>
        <td><button class="btn btn--neutral btn--sm" data-del-date="${r.exception_date}">Delete</button></td>
      </tr>
    `;
  }).join('');

  body.querySelectorAll('[data-del-date]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/settings/business-hours/delete-exception', {
          method: 'POST',
          body: { exception_date: btn.getAttribute('data-del-date') },
        });
        banner('Exception removed.', 'success');
        await loadAll();
      } catch {
        banner('Failed to remove exception.', 'error');
      }
    });
  });
}

async function saveException() {
  try {
    const exception_date = els['bh-ex-date']?.value || '';
    const is_closed = (els['bh-ex-closed']?.value || 'true') === 'true';
    const open_time = els['bh-ex-open']?.value || null;
    const close_time = els['bh-ex-close']?.value || null;
    const reason = (els['bh-ex-reason']?.value || '').trim() || null;

    await api('/api/settings/business-hours/save-exception', {
      method: 'POST',
      body: { exception_date, is_closed, open_time, close_time, reason },
    });

    banner('Exception saved.', 'success');
    await loadAll();
  } catch (e) {
    const msg = e?.data?.error || 'save_failed';
    banner(`Could not save exception (${msg}).`, 'error');
  }
}
