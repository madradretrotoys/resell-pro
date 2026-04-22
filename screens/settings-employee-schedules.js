import { api } from '/assets/js/api.js';

let els = {};
let editing = null;
let users = [];
let drawers = [];
let schedules = [];

export async function init() {
  bind();
  wire();
  await Promise.all([loadUsers(), loadDrawers(), loadSchedules()]);
}

export function destroy() {}

function bind() {
  const ids = [
    'sch-banner','sch-form-title','sch-user','sch-start','sch-end','sch-break','sch-status','sch-drawer','sch-notes','sch-save','sch-cancel','sch-body'
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

function wire() {
  els['sch-save']?.addEventListener('click', onSave);
  els['sch-cancel']?.addEventListener('click', clearForm);
}

function banner(message, tone = 'info') {
  const el = els['sch-banner'];
  if (!el) return;
  el.textContent = message;
  el.className = `banner ${tone}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
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
    banner(`Failed to save shift (${msg}).`, 'error');
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

function esc(v) {
  return String(v || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
