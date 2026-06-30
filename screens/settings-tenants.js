import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';

const els = {};
let organizations = [];
let businesses = [];
let tenants = [];
let editingTenantId = null;
function $(id) { return document.getElementById(id); }

export async function init({ session }) {
  if (!session?.user) session = await ensureSession();
  try { window.ui?.setTitle?.('Organization Settings'); } catch {}

  Object.assign(els, {
    banner: $('tenantBanner'),
    orgForm: $('organizationForm'), orgName: $('organizationName'), orgSlug: $('organizationSlug'), orgButton: $('btnCreateOrganization'),
    businessForm: $('businessForm'), businessOrg: $('businessOrganization'), businessName: $('businessName'), businessSlug: $('businessSlug'), businessButton: $('btnCreateBusiness'),
    form: $('tenantForm'), business: $('tenantBusiness'), name: $('tenantName'), slug: $('tenantSlug'),
    streetAddress: $('tenantStreetAddress'), city: $('tenantCity'), state: $('tenantState'), zip: $('tenantZip'), phone: $('tenantPhone'), email: $('tenantEmail'), logo: $('tenantLogo'),
    table: $('tenantsTable'), createButton: $('btnCreateTenant'), cancelButton: $('btnCancelTenantEdit'), editNotice: $('tenantEditNotice'), refreshButton: $('btnRefreshTenants'),
  });

  wireSlug(els.orgName, els.orgSlug);
  wireSlug(els.businessName, els.businessSlug);
  wireSlug(els.name, els.slug);
  els.orgForm?.addEventListener('submit', createOrganization);
  els.businessForm?.addEventListener('submit', createBusiness);
  els.form?.addEventListener('submit', saveTenant);
  els.refreshButton?.addEventListener('click', refresh);
  els.cancelButton?.addEventListener('click', resetTenantForm);
  els.table?.addEventListener('click', handleTenantTableClick);

  await refresh();
}

function wireSlug(nameEl, slugEl) {
  nameEl?.addEventListener('input', () => {
    if (!slugEl || slugEl.dataset.touched === 'true') return;
    slugEl.value = slugify(nameEl.value);
  });
  slugEl?.addEventListener('input', () => {
    slugEl.dataset.touched = 'true';
    slugEl.value = slugify(slugEl.value);
  });
}

async function refresh() {
  if (!els.table) return;
  els.table.innerHTML = 'Loading…';
  try {
    const [structure, data] = await Promise.all([
      api('/api/settings/tenants/structure'),
      api('/api/settings/tenants/list'),
    ]);
    organizations = structure.organizations || [];
    businesses = structure.businesses || [];
    tenants = data.tenants || [];
    renderSelects();
    els.table.innerHTML = renderStructure(tenants);
  } catch (e) {
    els.table.innerHTML = e?.status === 403
      ? 'Access denied. Ask an owner to grant Can add Tenant permission.'
      : 'Failed to load organization settings.';
  }
}

function renderSelects() {
  if (els.businessOrg) {
    els.businessOrg.innerHTML = organizations.length
      ? organizations.map((o) => `<option value="${escapeHtml(o.organization_id)}">${escapeHtml(o.name)}</option>`).join('')
      : '<option value="">Create an organization first</option>';
  }
  if (els.business) {
    els.business.innerHTML = businesses.length
      ? businesses.map((b) => `<option value="${escapeHtml(b.business_id)}">${escapeHtml(orgName(b.organization_id))} / ${escapeHtml(b.name)}</option>`).join('')
      : '<option value="">No business selected</option>';
  }
}

async function createOrganization(event) {
  event.preventDefault();
  const name = els.orgName?.value.trim() || '';
  if (!name) return showBanner('Organization name is required.', 'error');
  await createStructure('organization', { name, slug: slugify(els.orgSlug?.value || name) }, els.orgButton, 'Organization created successfully.', els.orgForm, els.orgSlug);
}

async function createBusiness(event) {
  event.preventDefault();
  const name = els.businessName?.value.trim() || '';
  const organization_id = els.businessOrg?.value || '';
  if (!organization_id) return showBanner('Create or select an organization first.', 'error');
  if (!name) return showBanner('Business name is required.', 'error');
  await createStructure('business', { organization_id, name, slug: slugify(els.businessSlug?.value || name) }, els.businessButton, 'Business created successfully.', els.businessForm, els.businessSlug);
}

async function createStructure(type, payload, button, success, form, slugEl) {
  button.disabled = true;
  try {
    await api('/api/settings/tenants/structure', { method: 'POST', body: { type, ...payload } });
    showBanner(success, 'success');
    form.reset();
    if (slugEl) delete slugEl.dataset.touched;
    await refresh();
  } catch (e) {
    const error = e?.data?.error;
    showBanner(error === 'organization_slug_exists' ? 'That organization slug is already in use.' : error === 'business_slug_exists' ? 'That business slug is already in use for this organization.' : 'Save failed.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function saveTenant(event) {
  event.preventDefault();
  const name = els.name?.value.trim() || '';
  const slug = slugify(els.slug?.value || name);
  if (!name) return showBanner('Tenant/location name is required.', 'error');

  const body = new FormData();
  body.set('name', name); body.set('slug', slug);
  body.set('business_id', els.business?.value || '');
  body.set('street_address', els.streetAddress?.value.trim() || '');
  body.set('city', els.city?.value.trim() || ''); body.set('state', els.state?.value.trim() || ''); body.set('zip', els.zip?.value.trim() || '');
  body.set('phone', els.phone?.value.trim() || ''); body.set('email', els.email?.value.trim() || '');
  const logoFile = els.logo?.files?.[0];
  if (logoFile) body.set('logo', logoFile);

  if (editingTenantId) body.set('tenant_id', editingTenantId);

  els.createButton.disabled = true;
  try {
    const endpoint = editingTenantId ? '/api/settings/tenants/update' : '/api/settings/tenants/create';
    await api(endpoint, { method: 'POST', body });
    showBanner(editingTenantId ? 'Tenant/location updated successfully.' : 'Tenant/location created successfully.', 'success');
    resetTenantForm();
    await refresh();
  } catch (e) {
    const error = e?.data?.error;
    const message = error === 'slug_exists' ? 'That slug is already in use. Choose another slug.' : error === 'forbidden' || error === 'forbidden_business' ? 'You do not have permission to save tenants for that business.' : error === 'invalid_email' ? 'Enter a valid tenant email address.' : error === 'invalid_phone_integer_range' ? 'Phone # cannot be saved until the tenant Phone column is migrated to text.' : error === 'logo_not_image' ? 'Choose an image file for the tenant logo.' : 'Tenant save failed.';
    showBanner(message, 'error');
  } finally {
    els.createButton.disabled = false;
  }
}

function renderStructure(tenants) {
  if (!organizations.length && !businesses.length && !tenants.length) return '<div class="muted">No organizations yet. Create an organization to get started.</div>';
  const orgHtml = organizations.map((org) => {
    const orgBusinesses = businesses.filter((b) => b.organization_id === org.organization_id);
    const businessHtml = orgBusinesses.length ? orgBusinesses.map((business) => renderBusiness(business, tenants)).join('') : '<div class="muted" style="margin:8px 0 0 16px;">No businesses yet.</div>';
    return `<section class="tile" style="margin:12px 0;"><h3>${escapeHtml(org.name)}</h3><p class="text-muted">Organization slug: ${escapeHtml(org.slug)}</p>${businessHtml}</section>`;
  }).join('');
  const unassigned = tenants.filter((t) => !t.business_id);
  const unassignedHtml = unassigned.length
    ? `<section class="tile" style="margin:12px 0;"><h3>Unassigned tenants</h3><p class="text-muted">Existing tenants without a business assignment remain available and unchanged.</p>${renderTenantTable(unassigned)}</section>`
    : '';
  return orgHtml + unassignedHtml;
}

function renderBusiness(business, tenants) {
  const businessTenants = tenants.filter((t) => t.business_id === business.business_id);
  return `<div style="margin:12px 0 0 16px;"><h4>${escapeHtml(business.name)}</h4><p class="text-muted">Business slug: ${escapeHtml(business.slug)}</p>${businessTenants.length ? renderTenantTable(businessTenants) : '<div class="muted">No tenants/locations yet.</div>'}</div>`;
}


function renderTenantTable(items) {
  const rows = items.map((tenant) => `
    <tr>
      <td style="width:150px;">${escapeHtml(tenant.name)}</td>
      <td style="width:120px;">${escapeHtml(tenant.slug)}</td>
      <td style="width:180px;">${escapeHtml(formatLocation(tenant))}</td>
      <td style="width:125px;">${escapeHtml(tenant.phone || '—')}</td>
      <td style="width:190px;">${escapeHtml(tenant.email || '—')}</td>
      <td style="width:90px; text-align:center;">${tenant.logo_url ? `<img src="${escapeHtml(tenant.logo_url)}" alt="${escapeHtml(tenant.name)} logo" style="max-height:32px; max-width:64px; object-fit:contain;">` : '—'}</td>
      <td style="width:140px;">${formatDate(tenant.created_at)}</td>
      <td style="width:360px;">${renderTenantActions(tenant)}</td>
    </tr>
  `).join('');
  return `
    <div style="overflow-x:auto; max-width:100%; padding-bottom:10px;" aria-label="Tenant assignments table scroll area">
      <table class="table" style="min-width:1355px; width:1355px; table-layout:fixed;">
        <thead>
          <tr><th style="width:150px;">Tenant/location</th><th style="width:120px;">Slug</th><th style="width:180px;">Location</th><th style="width:125px;">Phone</th><th style="width:190px;">Email</th><th style="width:90px;">Logo</th><th style="width:140px;">Created</th><th style="width:360px;">Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderTenantActions(tenant) {
  const options = ['<option value="">Unassigned</option>'].concat(
    businesses.map((business) => {
      const selected = tenant.business_id === business.business_id ? ' selected' : '';
      return `<option value="${escapeHtml(business.business_id)}"${selected}>${escapeHtml(orgName(business.organization_id))} / ${escapeHtml(business.name)}</option>`;
    })
  ).join('');
  return `
    <div class="flex" style="gap:8px; align-items:center; flex-wrap:wrap; max-width:340px;">
      <button class="btn btn--neutral btn--sm" type="button" data-edit-tenant="${escapeHtml(tenant.tenant_id)}">Load into form</button>
      <select data-tenant-business="${escapeHtml(tenant.tenant_id)}" style="width:220px; max-width:100%;" aria-label="Business assignment for ${escapeHtml(tenant.name)}">${options}</select>
      <button class="btn btn--neutral btn--sm" type="button" data-assign-tenant="${escapeHtml(tenant.tenant_id)}">Save assignment</button>
    </div>
  `;
}

async function handleTenantTableClick(event) {
  const editButton = event.target?.closest?.('[data-edit-tenant]');
  if (editButton) {
    startTenantEdit(editButton.dataset.editTenant || '');
    return;
  }

  const button = event.target?.closest?.('[data-assign-tenant]');
  if (!button) return;
  const tenant_id = button.dataset.assignTenant || '';
  const select = els.table?.querySelector?.(`[data-tenant-business="${cssEscape(tenant_id)}"]`);
  if (!tenant_id || !select) return;

  button.disabled = true;
  try {
    await api('/api/settings/tenants/structure', {
      method: 'POST',
      body: { type: 'tenant_business', tenant_id, business_id: select.value || '' },
    });
    showBanner('Tenant business assignment updated.', 'success');
    await refresh();
  } catch (e) {
    const error = e?.data?.error;
    showBanner(error === 'forbidden_business' ? 'You do not have permission to assign tenants to that business.' : 'Tenant business assignment failed.', 'error');
  } finally {
    button.disabled = false;
  }
}

function startTenantEdit(tenantId) {
  const tenant = tenants.find((item) => item.tenant_id === tenantId);
  if (!tenant) return showBanner('Tenant could not be found. Refresh and try again.', 'error');
  editingTenantId = tenantId;
  if (els.business) els.business.value = tenant.business_id || '';
  if (els.name) els.name.value = tenant.name || '';
  if (els.slug) { els.slug.value = tenant.slug || ''; els.slug.dataset.touched = 'true'; }
  if (els.streetAddress) els.streetAddress.value = tenant.street_address || '';
  if (els.city) els.city.value = tenant.city || '';
  if (els.state) els.state.value = tenant.state || '';
  if (els.zip) els.zip.value = tenant.zip || '';
  if (els.phone) els.phone.value = tenant.phone || '';
  if (els.email) els.email.value = tenant.email || '';
  if (els.logo) els.logo.value = '';
  if (els.createButton) els.createButton.textContent = 'Update tenant';
  if (els.cancelButton) els.cancelButton.hidden = false;
  setEditNotice(`Editing ${tenant.name}. Make changes in this form, then click Update tenant to save.`);
  els.form?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  els.name?.focus?.();
  showBanner(`Editing ${tenant.name}. No network request is sent until you click Update tenant.`, 'info');
}

function resetTenantForm() {
  editingTenantId = null;
  els.form?.reset();
  if (els.slug) delete els.slug.dataset.touched;
  if (els.createButton) els.createButton.textContent = 'Create tenant';
  if (els.cancelButton) els.cancelButton.hidden = true;
  setEditNotice('');
}

function setEditNotice(message) {
  if (!els.editNotice) return;
  els.editNotice.textContent = message;
  els.editNotice.hidden = !message;
}

function orgName(id) { return organizations.find((o) => o.organization_id === id)?.name || 'Unassigned organization'; }
function formatLocation(tenant) { const cityStateZip = [tenant.city, tenant.state, tenant.zip].filter(Boolean).join(', '); return [tenant.street_address, cityStateZip].filter(Boolean).join(' • ') || '—'; }
function slugify(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }
function formatDate(value) { const date = new Date(value); return value && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '—'; }
function showBanner(message, tone = 'info') { if (!els.banner) return; els.banner.textContent = message; els.banner.className = `banner ${tone}`; els.banner.hidden = false; }
function cssEscape(value) { return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
