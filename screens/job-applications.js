import { api } from '/assets/js/api.js';
import { showToast } from '/assets/js/ui.js';

let els = {};
let rows = [];

export async function init({ container }) {
  els = {
    tabNew: container.querySelector('#tabNew'), tabReview: container.querySelector('#tabReview'),
    panelNew: container.querySelector('#panelNew'), panelReview: container.querySelector('#panelReview'),
    form: container.querySelector('#applicationForm'),
    appsTable: container.querySelector('#appsTable'), search: container.querySelector('#search'), btnLoad: container.querySelector('#btnLoad'),
  };
  els.tabNew?.addEventListener('click', () => setTab('new'));
  els.tabReview?.addEventListener('click', () => setTab('review'));
  els.form?.addEventListener('submit', onSave);
  els.btnLoad?.addEventListener('click', loadRows);
  els.search?.addEventListener('input', renderRows);
  await loadRows();
}

function setTab(tab) {
  const review = tab === 'review';
  els.panelReview.style.display = review ? '' : 'none';
  els.panelNew.style.display = review ? 'none' : '';
}

async function onSave(e) {
  e.preventDefault();
  const fd = new FormData(els.form);
  const body = Object.fromEntries(fd.entries());
  if (!body.first_name?.trim() || !body.last_name?.trim()) {
    showToast('First and last name are required.');
    return;
  }
  if (body.currently_employed === '') delete body.currently_employed;
  else body.currently_employed = body.currently_employed === 'true';
  if (!body.available_start_date) delete body.available_start_date;
  if (!body.desired_pay_amount) delete body.desired_pay_amount;

  try {
    await api('/api/job-applications/save', { method: 'POST', body });
    showToast('Application saved.');
    els.form.reset();
    await loadRows();
    setTab('review');
  } catch (err) {
    showToast(err?.data?.error || 'Failed to save application.');
  }
}

async function loadRows() {
  try {
    const res = await api('/api/job-applications/list');
    rows = res.items || [];
    renderRows();
  } catch {
    rows = [];
    renderRows();
  }
}

function renderRows() {
  const q = (els.search?.value || '').trim().toLowerCase();
  const filtered = rows.filter((r) => !q || `${r.first_name} ${r.last_name} ${r.email || ''}`.toLowerCase().includes(q));
  if (!filtered.length) {
    els.appsTable.innerHTML = '<tbody><tr><td class="muted">No applications.</td></tr></tbody>';
    return;
  }
  els.appsTable.innerHTML = `<thead><tr><th>Name</th><th>Applied</th><th>Position</th><th>Status</th><th>Contact</th></tr></thead><tbody>${filtered.map((r)=>`<tr><td>${esc(r.last_name)}, ${esc(r.first_name)}</td><td>${esc(String(r.application_date || '').slice(0,10))}</td><td>${esc(r.position_sought || '')}</td><td>${esc(r.status || '')}</td><td>${esc(r.email || r.mobile_phone || '')}</td></tr>`).join('')}</tbody>`;
}
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
