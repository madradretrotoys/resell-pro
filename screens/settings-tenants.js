import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';

const els = {};
function $(id) { return document.getElementById(id); }

export async function init({ session }) {
  if (!session?.user) session = await ensureSession();

  els.banner = $('tenantBanner');
  els.organizationForm = $('organizationForm');
  els.form = $('tenantForm');
  els.organizationName = $('tenantOrganizationName');
  els.businessName = $('tenantBusinessName');
  els.name = $('tenantName');
  els.slug = $('tenantSlug');
  els.streetAddress = $('tenantStreetAddress');
  els.city = $('tenantCity');
  els.state = $('tenantState');
  els.zip = $('tenantZip');
  els.phone = $('tenantPhone');
  els.email = $('tenantEmail');
  els.logo = $('tenantLogo');
  els.organizationsTable = $('organizationsTable');
  els.table = $('tenantsTable');
  els.createOrganizationButton = $('btnCreateOrganization');
  els.refreshOrganizationsButton = $('btnRefreshOrganizations');
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
  els.organizationForm?.addEventListener('submit', createOrganizationBusiness);
  els.refreshOrganizationsButton?.addEventListener('click', refreshOrganizations);
  els.form?.addEventListener('submit', createTenant);
  els.refreshButton?.addEventListener('click', refresh);

  await refreshOrganizations();
  await refresh();
}

async function refreshOrganizations() {
  if (!els.organizationsTable) return;
  els.organizationsTable.innerHTML = 'Loading organizations…';
  try {
    const data = await api('/api/settings/organizations/list');
    if (data.hierarchy_schema_missing) {
      els.organizationsTable.innerHTML = '<div class="muted">Organization tables are not installed yet. Apply the organizations/businesses migration first.</div>';
      return;
    }
    els.organizationsTable.innerHTML = renderOrganizations(data.organizations || []);
  } catch (e) {
    els.organizationsTable.innerHTML = e?.status === 403
      ? 'Access denied. Ask an owner to grant Can add Tenant permission.'
      : 'Failed to load organizations.';
  }
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

async function createOrganizationBusiness(event) {
  event.preventDefault();
  const organizationName = els.organizationName?.value.trim() || '';
  const businessName = els.businessName?.value.trim() || '';
  if (!organizationName) return showBanner('Organization name is required.', 'error');
  if (!businessName) return showBanner('Business name is required.', 'error');

  els.createOrganizationButton.disabled = true;
  try {
    await api('/api/settings/organizations/create', {
      method: 'POST',
      body: {
        organization_name: organizationName,
        business_name: businessName,
      },
    });
    showBanner('Organization and business created successfully.', 'success');
    els.organizationForm.reset();
    await refreshOrganizations();
  } catch (e) {
    const error = e?.data?.error;
    const message = error === 'hierarchy_schema_missing'
      ? 'Apply the organizations/businesses migration before creating organizations and businesses.'
      : error === 'forbidden'
        ? 'You do not have permission to create organizations and businesses.'
        : 'Organization/business creation failed.';
    showBanner(message, 'error');
  } finally {
    els.createOrganizationButton.disabled = false;
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
  body.set('street_address', els.streetAddress?.value.trim() || '');
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
            ? 'Phone # cannot be saved until the tenant Phone column is migrated to text.'
            : error === 'logo_not_image'
              ? 'Choose an image file for the tenant logo.'
              : 'Tenant creation failed.';
    showBanner(message, 'error');
  } finally {
    els.createButton.disabled = false;
  }
}

function renderOrganizations(organizations) {
  if (!organizations.length) return '<div class="muted">No organizations or businesses yet.</div>';
  const rows = organizations.flatMap((organization) => {
    const businesses = organization.businesses || [];
    if (!businesses.length) {
      return [`
        <tr>
          <td>${escapeHtml(organization.name)}</td>
          <td>${escapeHtml(organization.slug)}</td>
          <td>—</td>
          <td>—</td>
          <td>${formatDate(organization.created_at)}</td>
        </tr>
      `];
    }

    return businesses.map((business) => `
      <tr>
        <td>${escapeHtml(organization.name)}</td>
        <td>${escapeHtml(organization.slug)}</td>
        <td>${escapeHtml(business.name)}</td>
        <td>${escapeHtml(business.slug)}</td>
        <td>${formatDate(business.created_at || organization.created_at)}</td>
      </tr>
    `);
  }).join('');

  return `
    <table class="table">
      <thead>
        <tr><th>Organization</th><th>Org slug</th><th>Business</th><th>Business slug</th><th>Created</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderTable(tenants) {
  if (!tenants.length) return '<div class="muted">No tenants yet.</div>';
  const rows = tenants.map((tenant) => `
    <tr>
      <td>${escapeHtml(tenant.organization_name || '—')}</td>
      <td>${escapeHtml(tenant.business_name || '—')}</td>
      <td>${escapeHtml(tenant.name)}</td>
      <td>${escapeHtml(tenant.slug)}</td>
      <td>${escapeHtml(formatLocation(tenant))}</td>
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
        <tr><th>Organization</th><th>Business</th><th>Tenant workspace</th><th>Slug</th><th>Location</th><th>Phone</th><th>Email</th><th>Logo</th><th>Your role</th><th>Your access active</th><th>Created</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function formatLocation(tenant) {
  const cityStateZip = [tenant.city, tenant.state, tenant.zip].filter(Boolean).join(', ');
  return [tenant.street_address, cityStateZip].filter(Boolean).join(' • ') || '—';
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
