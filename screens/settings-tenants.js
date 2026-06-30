import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';

const els = {};
function $(id) { return document.getElementById(id); }

export async function init({ session }) {
  if (!session?.user) session = await ensureSession();

  els.banner = $('tenantBanner');
  els.form = $('tenantForm');
  els.name = $('tenantName');
  els.slug = $('tenantSlug');
  els.city = $('tenantCity');
  els.state = $('tenantState');
  els.zip = $('tenantZip');
  els.phone = $('tenantPhone');
  els.email = $('tenantEmail');
  els.logo = $('tenantLogo');
  els.table = $('tenantsTable');
  els.createButton = $('btnCreateTenant');
  els.refreshButton = $('btnRefreshTenants');

  els.name?.addEventListener('input', () => {
    if (!els.slug || els.slug.dataset.touched === 'true') return;
    els.slug.value = slugify(els.name.value);
  });
  els.slug?.addEventListener('input', () => {
    els.slug.dataset.touched = 'true';
    els.slug.value = slugify(els.slug.value);
  });
  els.form?.addEventListener('submit', createTenant);
  els.refreshButton?.addEventListener('click', refresh);

  await refresh();
}

async function refresh() {
  if (!els.table) return;
  els.table.innerHTML = 'Loading…';
  try {
    const data = await api('/api/settings/tenants/list');
    els.table.innerHTML = renderTable(data.tenants || []);
  } catch (e) {
    els.table.innerHTML = e?.status === 403
      ? 'Access denied. Ask an owner to grant Can add Tenant permission.'
      : 'Failed to load tenants.';
  }
}

async function createTenant(event) {
  event.preventDefault();
  const name = els.name?.value.trim() || '';
  const slug = slugify(els.slug?.value || name);
  if (!name) return showBanner('Tenant name is required.', 'error');

  const body = new FormData();
  body.set('name', name);
  body.set('slug', slug);
  body.set('city', els.city?.value.trim() || '');
  body.set('state', els.state?.value.trim() || '');
  body.set('zip', els.zip?.value.trim() || '');
  body.set('phone', els.phone?.value.trim() || '');
  body.set('email', els.email?.value.trim() || '');
  const logoFile = els.logo?.files?.[0];
  if (logoFile) body.set('logo', logoFile);

  els.createButton.disabled = true;
  try {
    await api('/api/settings/tenants/create', { method: 'POST', body });
    showBanner('Tenant created successfully.', 'success');
    els.form.reset();
    if (els.slug) delete els.slug.dataset.touched;
    await refresh();
  } catch (e) {
    const error = e?.data?.error;
    const message = error === 'slug_exists'
      ? 'That slug is already in use. Choose another slug.'
      : error === 'forbidden'
        ? 'You do not have permission to create tenants.'
        : error === 'invalid_email'
          ? 'Enter a valid tenant email address.'
          : error === 'invalid_phone_integer_range'
            ? 'Phone # is too large for the current tenant phone database column.'
            : error === 'logo_not_image'
              ? 'Choose an image file for the tenant logo.'
              : 'Tenant creation failed.';
    showBanner(message, 'error');
  } finally {
    els.createButton.disabled = false;
  }
}

function renderTable(tenants) {
  if (!tenants.length) return '<div class="muted">No tenants yet.</div>';
  const rows = tenants.map((tenant) => `
    <tr>
      <td>${escapeHtml(tenant.name)}</td>
      <td>${escapeHtml(tenant.slug)}</td>
      <td>${escapeHtml([tenant.city, tenant.state, tenant.zip].filter(Boolean).join(', ') || '—')}</td>
      <td>${escapeHtml(tenant.phone || '—')}</td>
      <td>${escapeHtml(tenant.email || '—')}</td>
      <td>${tenant.logo_url ? `<img src="${escapeHtml(tenant.logo_url)}" alt="${escapeHtml(tenant.name)} logo" style="max-height:32px; max-width:80px; object-fit:contain;">` : '—'}</td>
      <td>${escapeHtml(tenant.actor_role || '—')}</td>
      <td>${tenant.actor_member_active ? 'Yes' : 'No'}</td>
      <td>${formatDate(tenant.created_at)}</td>
    </tr>
  `).join('');
  return `
    <table class="table">
      <thead>
        <tr><th>Name</th><th>Slug</th><th>Location</th><th>Phone</th><th>Email</th><th>Logo</th><th>Your role</th><th>Your access active</th><th>Created</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function showBanner(message, tone = 'info') {
  if (!els.banner) return;
  els.banner.textContent = message;
  els.banner.className = `banner ${tone}`;
  els.banner.hidden = false;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
