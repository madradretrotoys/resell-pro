// screens/inventory.js
// Phase 1 UI: server-side paging/sort/search/filter, dynamic columns, per-user column prefs, exact-then-approx count flag.
// Currency: USD now; tax-inclusive display uses /api/settings/tax (env DEFAULT_TAX_RATE) without hitting tax_rates.
// Permissions: gated server-side (mirror can_inventory).

import { api } from '/assets/js/api.js';
import { ensureSession } from '/assets/js/auth.js';
import { applyButtonGroupColors } from '/assets/js/ui.js';

const els = {};
const state = {
  session: null,
  columns: [],          // [{name,label,type,currency,visible_default}, ...]
  visibleCols: [],      // string[]
  search: '',
  filters: [],          // [{ column, op, value }]
  sort: { column: 'updated_at', dir: 'desc' },
  limit: 50,
  offset: 0,
  total: 0,
  approximate: false,
  
};

const COL_PREF_KEY = (uid) => `rp.inventory.visibleCols.${uid || 'anon'}`;

function $(id){ return document.getElementById(id); }
function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&','<':'<','>':'>','"':'"',"'" :"'"}[c])); }
function fmtCurrency(n){ try{ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n||0)); }catch{ return `$${Number(n||0).toFixed(2)}`; } }

export async function init({ container, session }) {
  state.session = session?.user ? session : await ensureSession();
  if (!state.session?.user) {
    container.innerHTML = 'Not signed in.';
    return;
  }

  // Bind
  els.head = $('invHead');
  els.body = $('invBody');
  els.count = $('invCount');
  els.search = $('invSearch');
  els.btnFilter = $('invBtnFilter');
  els.btnColumns = $('invBtnColumns');
  els.pageSize = $('invPageSize');
  els.prev = $('invPrev');
  els.next = $('invNext');
  els.columnsDlg = $('invColumnsDlg');
  els.columnsList = $('invColumnsList');
  els.columnsSave = $('invColumnsSave');
  els.filterDlg = $('invFilterDlg');
  els.filterArea = $('invFilterRows');
  els.filterAdd = $('invAddFilter');
  els.filterApply = $('invFilterApply');

  // Apply app-wide styles to controls (protocol classes)
  els.search?.classList?.add('input', 'input-sm');
  els.btnFilter?.classList?.add('btn', 'btn-sm');
  els.btnColumns?.classList?.add('btn', 'btn-sm');
  els.prev?.classList?.add('btn', 'btn-sm');
  els.next?.classList?.add('btn', 'btn-sm');
  els.pageSize?.classList?.add('select', 'select-sm');
  
  // Global color roles: first = blue, neighbors = ghost
  applyButtonGroupColors(document.getElementById('invControls'));
  applyButtonGroupColors(document.getElementById('invPager'), { allGhost: true });
  
  // Optional: if you have a standard table class, uncomment the next two lines
  document.getElementById('invTable')?.classList?.add('table', 'table-sm');
  document.getElementById('invTableWrap')?.classList?.add('card');
  
  if (els.search) {
    els.search.oninput = debounce(() => { state.search = els.search.value.trim(); state.offset = 0; refresh(); }, 300);
  }
  if (els.pageSize) {
    els.pageSize.onchange = () => { state.limit = Number(els.pageSize.value || 50); state.offset = 0; refresh(); };
  }
  if (els.prev) els.prev.onclick = () => { state.offset = Math.max(0, state.offset - state.limit); refresh(); };
  if (els.next) els.next.onclick = () => { state.offset = state.offset + state.limit; refresh(); };
  if (els.btnColumns) els.btnColumns.onclick = openColumns;
  if (els.columnsSave) els.columnsSave.onclick = saveColumns;
  if (els.btnFilter) els.btnFilter.onclick = openFilters;
  if (els.filterAdd) els.filterAdd.onclick = addFilterRow;
  if (els.filterApply) els.filterApply.onclick = applyFilters;

  
  // Load columns + defaults + tax
  await loadColumns();
  

  // Initial fetch
  await refresh();
}

async function loadColumns(){
  const meta = await api('/api/inventory/columns');
  state.columns = meta.columns || [];
  state.sort = meta.default_sort || { column: 'updated_at', dir: 'desc' };

  // Per-user persisted visible columns
  const uid = state.session?.user?.user_id;
  const saved = safeParse(localStorage.getItem(COL_PREF_KEY(uid)));
  const defaultVisible = state.columns.filter(c => c.visible_default).map(c => c.name);
  state.visibleCols = Array.isArray(saved) && saved.length ? saved : defaultVisible;

  // Build header
  renderHead();
  buildColumnsDialog();
}



async function refresh(){
  if (!els.body) return;
  els.body.innerHTML = '<tr><td style="padding:12px;">Loading…</td></tr>';

  // For Phase 1: use unified query endpoint so filters/search share a codepath
  const body = {
    q: state.search,
    filters: state.filters,
    sort: state.sort,
    limit: state.limit,
    offset: state.offset,
  };

  try {
    const data = await api('/api/inventory/query', { method: 'POST', body });
    state.total = Number(data.total || 0);
    state.approximate = !!data.approximate;

    renderRows(data.items || []);
    renderCount();
  } catch (e) {
    if (e?.status === 403) {
      els.body.innerHTML = `<tr><td style="padding:12px;">Access denied. Ask an owner to grant Inventory access.</td></tr>`;
      return;
    }
    els.body.innerHTML = `<tr><td style="padding:12px;">Failed to load inventory.</td></tr>`;
  }
}

function renderHead(){
  const cols = state.visibleCols;
  const ths = cols.map(name => {
    const meta = state.columns.find(c => c.name === name);
    const label = meta?.label || name;
    const isSorted = state.sort.column === name;
    const dir = isSorted ? (state.sort.dir === 'asc' ? '↑' : '↓') : '';
    return `<th data-col="${escapeHtml(name)}" style="padding:8px; border-bottom:1px solid #eee; text-align:left; cursor:pointer;">${escapeHtml(label)} ${dir}</th>`;
  });
  els.head.innerHTML = `<tr>${ths.join('')}</tr>`;

  // Sort handlers
  setTimeout(() => {
    els.head.querySelectorAll('th[data-col]').forEach(th => {
      th.onclick = () => {
        const c = th.getAttribute('data-col');
        if (state.sort.column === c) state.sort.dir = (state.sort.dir === 'asc') ? 'desc' : 'asc';
        else { state.sort.column = c; state.sort.dir = 'asc'; }
        state.offset = 0;
        refresh();
      };
    });
  }, 0);
}

function renderRows(items){
  if (!items.length) {
    els.body.innerHTML = `<tr><td style="padding:12px;">No results.</td></tr>`;
    return;
  }
  const cols = state.visibleCols;
  const rows = items.map(item => {
    const tds = cols.map(name => {
      let v = item[name];
      if (name === 'vendoo_item_url' && v) {
        return `<td style="padding:6px; border-bottom:1px solid #f4f4f4;"><a href="${escapeHtml(v)}" target="_blank" rel="noopener">View</a></td>`;
      }
      if (name === 'price' || name === 'cost_cogs') {
        // Display exactly what DB returns; no numeric coercion or formatting.
        return `<td style="padding:6px; border-bottom:1px solid #f4f4f4;">${escapeHtml(v)}</td>`;
      }
      if (name === 'updated_at' && v) {
        const d = new Date(v);
        return `<td style="padding:6px; border-bottom:1px solid #f4f4f4;">${d.toLocaleString()}</td>`;
      }
      if (name === 'sku') {
        // Placeholder "thumbnail" prefix (image to come later)
        return `<td style="padding:6px; border-bottom:1px solid #f4f4f4;">🖼️&nbsp;${escapeHtml(v)}</td>`;
      }
      return `<td style="padding:6px; border-bottom:1px solid #f4f4f4;">${escapeHtml(v)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');

  els.body.innerHTML = rows;
}

function renderCount(){
  const prefix = state.approximate ? '≈' : '';
  const start = state.total ? (state.offset + 1) : 0;
  const end = Math.min(state.total, state.offset + state.limit);
  els.count.textContent = `${prefix}${state.total} items — showing ${start}-${end}`;
}

function buildColumnsDialog(){
  if (!els.columnsDlg || !els.columnsList) return;
  const items = state.columns.map(c => {
    const checked = state.visibleCols.includes(c.name) ? 'checked' : '';
    return `<label style="display:flex; gap:6px; align-items:center;"><input type="checkbox" data-col="${escapeHtml(c.name)}" ${checked}> ${escapeHtml(c.label || c.name)}</label>`;
  }).join('');
  els.columnsList.innerHTML = items;
}

function openColumns(){
  buildColumnsDialog();
  els.columnsDlg.showModal();
}

function saveColumns(ev){
  ev?.preventDefault?.();
  const boxes = els.columnsList.querySelectorAll('input[type="checkbox"][data-col]');
  const selected = Array.from(boxes).filter(b => b.checked).map(b => b.getAttribute('data-col'));
  if (selected.length) {
    state.visibleCols = selected;
    const uid = state.session?.user?.user_id;
    localStorage.setItem(COL_PREF_KEY(uid), JSON.stringify(selected));
    renderHead();
    refresh();
  }
  els.columnsDlg.close();
}

function openFilters(){
  // Simple builder: add rows with dropdowns based on types
  els.filterArea.innerHTML = '';
  addFilterRow();
  els.filterDlg.showModal();
}

function addFilterRow(){
  const selCol = `<select data-role="column">${state.columns.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.label || c.name)}</option>`).join('')}</select>`;
  const selOpNum = `<select data-role="op"><option value="gte">&ge;</option><option value="gt">&gt;</option><option value="lte">&le;</option><option value="lt">&lt;</option><option value="eq">=</option></select>`;
  const selOpTxt = `<select data-role="op"><option value="ilike">Contains</option><option value="eq">Equals</option></select>`;
  const val = `<input data-role="value" placeholder="value">`;
  const row = document.createElement('div');
  row.style.display = 'grid';
  row.style.gridTemplateColumns = '1fr 1fr 1fr auto';
  row.style.gap = '6px';
  const firstCol = state.columns[0]?.name || 'title';
  const isNum = (name) => ['price','qty','cost_cogs','weight_oz','length_in','width_in','height_in'].includes(name);
  row.innerHTML = `${selCol}${selOpTxt}${val}<button type="button">Remove</button>`;
  els.filterArea.appendChild(row);

  const colSel = row.querySelector('select[data-role="column"]');
  const opSel = row.querySelector('select[data-role="op"]');
  const rmBtn = row.querySelector('button');

  const rewire = () => {
    const name = colSel.value;
    const was = opSel.value;
    if (isNum(name)) opSel.outerHTML = selOpNum;
    else opSel.outerHTML = selOpTxt;
    row.querySelector('select[data-role="op"]').value = was;
  };
  colSel.onchange = rewire;
  rmBtn.onclick = () => row.remove();
  rewire();
}

function applyFilters(ev){
  ev?.preventDefault?.();
  const rows = els.filterArea.querySelectorAll('div');
  const fs = [];
  rows.forEach(r => {
    const col = r.querySelector('select[data-role="column"]')?.value;
    const op = r.querySelector('select[data-role="op"]')?.value;
    const val = r.querySelector('input[data-role="value"]')?.value;
    if (!col || !op) return;
    if (op === 'isnull' || op === 'notnull') fs.push({ column: col, op });
    else if (val !== undefined) fs.push({ column: col, op, value: val });
  });
  state.filters = fs;
  state.offset = 0;
  els.filterDlg.close();
  refresh();
}

function debounce(fn, ms){
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function safeParse(s){
  try { return JSON.parse(s); } catch { return null; }
}
