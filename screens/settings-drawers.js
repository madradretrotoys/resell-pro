import { api } from '/assets/js/api.js';

let els = {};
let editingDrawer = null;

export async function init() {
  bind();
  wire();
  await loadDrawers();
}

export function destroy() {}

function bind() {
  const ids = [
    'drw-banner',
    'drw-form-title',
    'drw-name',
    'drw-code',
    'drw-location',
    'drw-float',
    'drw-save',
    'drw-cancel',
    'drw-body',
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

function wire() {
  els['drw-save']?.addEventListener('click', onSave);
  els['drw-cancel']?.addEventListener('click', clearForm);
}

function banner(message, tone = 'info') {
  const el = els['drw-banner'];
  if (!el) return;
  el.textContent = message;
  el.className = `banner ${tone}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
}

function clearForm() {
  editingDrawer = null;
  if (els['drw-form-title']) els['drw-form-title'].textContent = 'Create Drawer';
  if (els['drw-save']) els['drw-save'].textContent = 'Create Drawer';
  if (els['drw-cancel']) els['drw-cancel'].hidden = true;
  if (els['drw-name']) els['drw-name'].value = '';
  if (els['drw-code']) els['drw-code'].value = '';
  if (els['drw-location']) els['drw-location'].value = '';
  if (els['drw-float']) els['drw-float'].value = '0';
}

async function loadDrawers() {
  try {
    const resp = await api('/api/settings/drawers/list');
    const rows = Array.isArray(resp?.drawers) ? resp.drawers : [];
    renderRows(rows);
  } catch {
    banner('Failed to load drawers.', 'error');
  }
}

function renderRows(rows) {
  const body = els['drw-body'];
  if (!body) return;
  body.innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(r.drawer_name)}</td>
      <td>${esc(r.drawer_code || '')}</td>
      <td>${esc(r.location_name || '')}</td>
      <td>${fmtMoney(r.starting_float_default)}</td>
      <td>${r.is_active ? 'Active' : 'Inactive'}</td>
      <td>
        <div style="display:flex; gap:6px;">
          <button class="btn btn--neutral btn--sm" data-edit="${r.drawer_id}">Edit</button>
          <button class="btn btn--neutral btn--sm" data-toggle="${r.drawer_id}" data-next="${r.is_active ? 'false' : 'true'}">${r.is_active ? 'Deactivate' : 'Activate'}</button>
        </div>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = rows.find((x) => x.drawer_id === btn.getAttribute('data-edit'));
      if (!row) return;
      editingDrawer = row.drawer_id;
      if (els['drw-form-title']) els['drw-form-title'].textContent = 'Edit Drawer';
      if (els['drw-save']) els['drw-save'].textContent = 'Save Changes';
      if (els['drw-cancel']) els['drw-cancel'].hidden = false;
      if (els['drw-name']) els['drw-name'].value = row.drawer_name || '';
      if (els['drw-code']) els['drw-code'].value = row.drawer_code || '';
      if (els['drw-location']) els['drw-location'].value = row.location_name || '';
      if (els['drw-float']) els['drw-float'].value = String(Number(row.starting_float_default || 0));
    });
  });

  body.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const drawer_id = btn.getAttribute('data-toggle');
      const is_active = btn.getAttribute('data-next') === 'true';
      try {
        await api('/api/settings/drawers/deactivate', {
          method: 'POST',
          body: { drawer_id, is_active },
        });
        banner(`Drawer ${is_active ? 'activated' : 'deactivated'}.`, 'success');
        await loadDrawers();
      } catch (e) {
        const msg = e?.data?.error || 'save_failed';
        banner(`Failed to update drawer (${msg}).`, 'error');
      }
    });
  });
}

async function onSave() {
  const drawer_name = String(els['drw-name']?.value || '').trim();
  const drawer_code = String(els['drw-code']?.value || '').trim() || null;
  const location_name = String(els['drw-location']?.value || '').trim() || null;
  const starting_float_default = Number(els['drw-float']?.value || 0);

  if (!drawer_name) {
    banner('Drawer name is required.', 'error');
    return;
  }

  try {
    if (editingDrawer) {
      await api('/api/settings/drawers/update', {
        method: 'POST',
        body: {
          drawer_id: editingDrawer,
          drawer_name,
          drawer_code,
          location_name,
          starting_float_default,
        },
      });
      banner('Drawer updated.', 'success');
    } else {
      await api('/api/settings/drawers/create', {
        method: 'POST',
        body: {
          drawer_name,
          drawer_code,
          location_name,
          starting_float_default,
        },
      });
      banner('Drawer created.', 'success');
    }

    clearForm();
    await loadDrawers();
  } catch (e) {
    const msg = e?.data?.error || 'save_failed';
    banner(`Could not save drawer (${msg}).`, 'error');
  }
}

function fmtMoney(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function esc(v) {
  return String(v || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
