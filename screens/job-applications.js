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
    detailDialog: container.querySelector('#applicationDetailDialog'), detailBody: container.querySelector('#applicationDetailBody'),
  };
  els.tabNew?.addEventListener('click', () => setTab('new'));
  els.tabReview?.addEventListener('click', () => setTab('review'));
  els.form?.addEventListener('submit', onSave);
  els.btnLoad?.addEventListener('click', loadRows);
  els.search?.addEventListener('input', renderRows);
  els.appsTable?.addEventListener('click', onTableClick);
  setStartDateMinimum();
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
  body.status = e?.submitter?.dataset?.saveMode === 'submitted' ? 'submitted' : 'draft';
  if (!body.available_start_date) delete body.available_start_date;
  else if (body.available_start_date < todayYmd()) {
    showToast('Available start date cannot be in the past.');
    return;
  }
  if (!body.desired_pay_amount) delete body.desired_pay_amount;

  try {
    await api('/api/job-applications/save', { method: 'POST', body });
    showToast('Application saved.');
    els.form.reset();
    setStartDateMinimum();
    await loadRows();
    setTab('review');
  } catch (err) {
    showToast(err?.data?.error || 'Failed to save application.');
  }
}

function setStartDateMinimum() {
  const node = els.form?.querySelector('input[name="available_start_date"]');
  if (!node) return;
  node.min = todayYmd();
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  els.appsTable.innerHTML = `<thead><tr><th>Name</th><th>Applied</th><th>Position</th><th>Status</th><th>Contact</th></tr></thead><tbody>${filtered.map((r)=>`<tr data-id="${esc(r.job_application_id)}" style="cursor:pointer;"><td>${esc(r.last_name)}, ${esc(r.first_name)}</td><td>${esc(String(r.application_date || '').slice(0,10))}</td><td>${esc(r.position_sought || '')}</td><td>${esc(r.status || '')}</td><td>${esc(r.email || r.mobile_phone || '')}</td></tr>`).join('')}</tbody>`;
}

async function onTableClick(e) {
  const tr = e.target?.closest?.('tr[data-id]');
  if (!tr) return;
  const id = tr.getAttribute('data-id');
  if (!id) return;
  try {
    const res = await api(`/api/job-applications/list?job_application_id=${encodeURIComponent(id)}`);
    renderDetail(res?.item || null);
    els.detailDialog?.showModal?.();
  } catch (err) {
    showToast(err?.data?.error || 'Unable to load application detail.');
  }
}

function renderDetail(item) {
  if (!els.detailBody) return;
  if (!item) {
    els.detailBody.innerHTML = '<p class="muted">Application not found.</p>';
    return;
  }
  const fields = [
    ['Applicant', `${item.last_name || ''}, ${item.first_name || ''} ${item.middle_name || ''}`.trim()],
    ['Applied Date', String(item.application_date || '').slice(0, 10)],
    ['Status', item.status],
    ['Position Sought', item.position_sought],
    ['Available Start', String(item.available_start_date || '').slice(0, 10)],
    ['Email', item.email],
    ['Mobile Phone', item.mobile_phone],
    ['Home Phone', item.home_phone],
    ['Address', [item.address_line1, item.address_line2, item.city, item.state_province, item.postal_code].filter(Boolean).join(', ')],
    ['Referral Source', item.referral_source],
    ['Desired Pay', item.desired_pay_amount ? `${item.desired_pay_amount} ${item.desired_pay_period || ''}`.trim() : ''],
    ['Currently Employed', item.currently_employed === null ? '' : (item.currently_employed ? 'Yes' : 'No')],
    ['Skills/Notes', item.proficiency_skills_notes],
    ['Internal Notes', item.internal_notes],
  ];

  els.detailBody.innerHTML = `<div style="display:grid;grid-template-columns:220px 1fr;gap:8px 12px;">${fields.map(([k,v])=>`<div class="muted"><strong>${esc(k)}</strong></div><div>${esc(v || '—')}</div>`).join('')}</div>`;
}
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
