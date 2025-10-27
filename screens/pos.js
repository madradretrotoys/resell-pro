// POS Screen (Cloudflare + Neon)
import { ensureSession } from "../assets/js/auth.js";
import { api } from "../assets/js/api.js";
import { showToast, applyButtonGroupColors } from "../assets/js/ui.js"; // ui.js exports
// Local helper: ui.js doesn't export fmtCurrency in this repo
const fmtCurrency = (n) => {
  const v = Number(n || 0);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
};
/**
 * Router entry point
 * @param {{container:HTMLElement, session:Object}} ctx
 */
export async function init(ctx) {
  const root = ctx.container;
  const el = {
    banner: root.querySelector("#screen-banner"),
    denied: root.querySelector("#screen-access-denied"),
    loading: root.querySelector("#screen-loading"),
    content: root.querySelector("#screen-content"),
    // search
    q: root.querySelector("#pos-search"),
    qBtn: root.querySelector("#pos-search-btn"),
    qClear: root.querySelector("#pos-search-clear"),
    results: root.querySelector("#pos-results"),
    quickMisc: root.querySelector("#pos-quick-misc"),
    // cart
    cart: root.querySelector("#pos-cart"),
    discountInput: root.querySelector("#pos-discount-input"),
    discountApply: root.querySelector("#pos-discount-apply"),
    ticketEmpty: root.querySelector("#pos-ticket-empty"),
    // totals
    subtotal: root.querySelector("#pos-subtotal"),
    discounts: root.querySelector("#pos-discounts"),
    tax: root.querySelector("#pos-tax"),
    total: root.querySelector("#pos-total"),
    // payment
    payment: root.querySelector("#pos-payment"),
    split: root.querySelector("#pos-split"),
    customer: root.querySelector("#pos-customer"),
    complete: root.querySelector("#pos-complete"),
    // logs
    logs: root.querySelector("#pos-logs"),
    // sales
    salesToday: root.querySelector("#pos-sales-today"),
    dateFrom: root.querySelector("#pos-date-from"),
    dateTo: root.querySelector("#pos-date-to"),
    salesLoad: root.querySelector("#pos-sales-load"),
    salesBody: root.querySelector("#pos-sales-body"),
  };

  try {
    await ensureSession(); // server-check + redirects if needed
  } catch {
    swap("denied"); // show access denied shell
    return;
  }

  swap("loading");
  const state = makeState();

  // Load POS metadata (tax, payment options, env flags, etc.)
  let meta = {};
  try {
    meta = await api("/api/pos/meta", { method: "GET" });
    state.taxRate = Number(meta.tax_rate ?? 0);
  } catch (err) {
    log(`meta error: ${err?.message || err}`);
  }

  wireSearch();
  wireCart();
  wireTotals();
  wireSales();

  swap("content");
  render();

  // ————— helpers —————

  function swap(which) {
    el.banner.classList.add("hidden");
    el.denied.classList.add("hidden");
    el.loading.classList.add("hidden");
    el.content.classList.add("hidden");
    if (which === "denied") el.denied.classList.remove("hidden");
    if (which === "loading") el.loading.classList.remove("hidden");
    if (which === "content") el.content.classList.remove("hidden");
  }

  function makeState() {
    return {
      items: [], // [{sku, name, price, qty}]
      discount: { mode: "percent", value: 0 }, // or {mode:'amount'}
      taxRate: 0.0,
      totals: { subtotal: 0, discount: 0, tax: 0, total: 0 },
    };
  }

  function wireSearch() {
    el.qBtn.addEventListener("click", () => doSearch());
    el.q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });
    el.qClear.addEventListener("click", () => {
      el.q.value = "";
      el.results.innerHTML = "";
    });
    el.quickMisc.addEventListener("click", () => {
      // Add a one-off “Misc” line at $0.00 for quick custom price
      state.items.push({ sku: null, name: "Misc item", price: 0, qty: 1 });
      render();
    });
  }

  async function doSearch() {
    const q = (el.q.value || "").trim();
    if (!q) return;
    el.results.innerHTML = `<div class="text-sm text-muted">Searching…</div>`;
    try {
      // If you already have an inventory search endpoint, swap it in here:
      // const res = await api(`/api/inventory/search?q=${encodeURIComponent(q)}`);
      // For now, use meta as a placeholder/no-op result:
      const res = { items: [] };
      renderResults(res.items || []);
    } catch (err) {
      el.results.innerHTML = `<div class="text-danger text-sm">Search failed</div>`;
      log(err?.message || err);
    }
  }

  function renderResults(items) {
    if (!items.length) {
      el.results.innerHTML = `<div class="text-sm text-muted">No items found</div>`;
      return;
    }
    el.results.innerHTML = items
      .map(
        (it) => `
        <div class="flex items-center justify-between p-2 border rounded">
          <div class="min-w-0">
            <div class="font-medium truncate">${escapeHtml(it.name)}</div>
            <div class="text-xs text-muted">SKU: ${escapeHtml(it.sku || "")}</div>
            <div class="text-xs">${fmtCurrency(it.price || 0)}</div>
          </div>
          <button class="btn btn-sm btn-primary" data-add='${JSON.stringify({
            sku: it.sku,
            name: it.name,
            price: it.price,
          }).replaceAll("'", "&apos;")}'>Add</button>
        </div>`
      )
      .join("");

    // delegate add clicks
    el.results.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-add]");
      if (!btn) return;
      const data = JSON.parse(btn.getAttribute("data-add"));
      const found = state.items.find((x) => x.sku && x.sku === data.sku);
      if (found) found.qty += 1;
      else state.items.push({ ...data, qty: 1 });
      render();
    }, { once: true });
  }

  function wireCart() {
    el.ticketEmpty.addEventListener("click", () => {
      state.items = [];
      state.discount = { mode: "percent", value: 0 };
      render();
    });

    el.discountApply.addEventListener("click", async () => {
      const mode =
        root.querySelector('input[name="pos-discount-mode"]:checked')?.value ||
        "percent";
      const raw = Number(el.discountInput.value || 0);
      state.discount = { mode, value: isFinite(raw) ? raw : 0 };
      await refreshTotalsViaServer();
    });
  }

  function wireTotals() {
    el.complete.addEventListener("click", async () => {
      if (!state.items.length) return;
      const payment = el.payment.value;
      if (!payment) return;
      try {
        const body = {
          items: state.items,
          discount: state.discount,
          customer: (el.customer.value || "").trim() || null,
          payment,
        };
        const res = await api("/api/pos/checkout/start", {
          method: "POST",
          json: body,
        });
        log(res);
        // show optimistic accepted state (Valor VC07 timeouts treated as accepted)
        el.banner.classList.remove("hidden");
        el.banner.innerHTML =
          `<div class="card p-2">Sale started — awaiting processor result…</div>`;
      } catch (err) {
        el.banner.classList.remove("hidden");
        el.banner.innerHTML =
          `<div class="card p-2">Checkout failed: ${escapeHtml(err?.message || String(err))}</div>`;
      }
    });
  }

  function wireSales() {
    el.salesToday.addEventListener("click", async () => {
      await loadSales({ preset: "today" });
    });
    el.salesLoad.addEventListener("click", async () => {
      const from = el.dateFrom.value || null;
      const to = el.dateTo.value || null;
      await loadSales({ from, to });
    });
  }

  async function loadSales({ preset, from, to } = {}) {
    try {
      const q = new URLSearchParams();
      if (preset) q.set("preset", preset);
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      const res = await api(`/api/pos/sales?${q.toString()}`, { method: "GET" });
      const rows = res?.rows || [];
      el.salesBody.innerHTML = rows
        .map((r) => {
          return `<tr>
            <td>${escapeHtml(r.time)}</td>
            <td>${escapeHtml(r.sale_id)}</td>
            <td>${escapeHtml(r.payment || "")}</td>
            <td>${fmtCurrency(r.total || 0)}</td>
            <td>${escapeHtml(r.clerk || "")}</td>
            <td>
              <button class="btn btn-xs" data-copy='${r.sale_id}'>Copy total</button>
              <button class="btn btn-xs btn-ghost" data-refund='${r.sale_id}'>Refund…</button>
            </td>
          </tr>`;
        })
        .join("");
    } catch (err) {
      log(`sales load failed: ${err?.message || err}`);
    }
  }

  function cartRow(it, idx) {
    return `
      <div class="py-2 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-medium truncate">${escapeHtml(it.name)}</div>
          <div class="text-xs text-muted">${it.sku ? "SKU: " + escapeHtml(it.sku) : "Custom"}</div>
        </div>
        <div class="flex items-center gap-2">
          <div class="inline-flex items-center gap-1">
            <button class="btn btn-xs" data-qty="${idx}|-">−</button>
            <span class="w-8 text-center">${it.qty}</span>
            <button class="btn btn-xs" data-qty="${idx}|+">+</button>
          </div>
          <div class="w-20 text-right">${fmtCurrency(it.price)}</div>
          <button class="btn btn-ghost btn-xs" data-remove="${idx}">Remove</button>
        </div>
      </div>
    `;
  }

  function render() {
    // cart list
    el.cart.innerHTML = state.items.map(cartRow).join("");

    // bind qty/remove once per render
    el.cart.querySelectorAll("[data-qty]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const [i, op] = btn.getAttribute("data-qty").split("|");
        const idx = Number(i);
        const item = state.items[idx];
        if (!item) return;
        item.qty = Math.max(1, item.qty + (op === "+" ? 1 : -1));
        await refreshTotalsViaServer();
      });
    });
    el.cart.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = Number(btn.getAttribute("data-remove"));
        state.items.splice(idx, 1);
        await refreshTotalsViaServer();
      });
    });

    // totals (client fallback until server calculates)
    computeTotalsClient();
    paintTotals();
  }

  function computeTotalsClient() {
    const subtotal = state.items.reduce((s, it) => s + (it.price || 0) * (it.qty || 0), 0);
    let discount = 0;
    if (state.discount.mode === "percent") {
      discount = subtotal * (Number(state.discount.value || 0) / 100);
    } else {
      discount = Number(state.discount.value || 0);
    }
    discount = Math.min(discount, subtotal);
    const taxable = Math.max(0, subtotal - discount);
    const tax = taxable * Number(state.taxRate || 0);
    const total = taxable + tax;
    state.totals = { subtotal, discount, tax, total };
  }

  async function refreshTotalsViaServer() {
    try {
      const body = { items: state.items, discount: state.discount };
      const r = await api("/api/pos/price/preview", { method: "POST", json: body });
      if (r && typeof r.subtotal === "number") {
        state.totals = {
          subtotal: r.subtotal,
          discount: r.discount,
          tax: r.tax,
          total: r.total,
        };
        if (typeof r.tax_rate === "number") state.taxRate = r.tax_rate;
        if (r.capped && r.message) {
          el.banner.classList.remove("hidden");
          el.banner.innerHTML = `<div class="card p-2">${escapeHtml(r.message)}</div>`;
        } else {
          el.banner.classList.add("hidden");
          el.banner.innerHTML = "";
        }
      } else {
        computeTotalsClient();
      }
    } catch (err) {
      computeTotalsClient();
      log(`preview failed: ${err?.message || err}`);
    }
    paintTotals();
  }

  function paintTotals() {
    el.subtotal.textContent = fmtCurrency(state.totals.subtotal);
    el.discounts.textContent = `-${fmtCurrency(state.totals.discount)}`;
    el.tax.textContent = fmtCurrency(state.totals.tax);
    el.total.textContent = fmtCurrency(state.totals.total);
  }

  function log(msg) {
    if (!el.logs) return;
    const line = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
    el.logs.textContent = `${el.logs.textContent || ""}\n${line}`.trim();
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
}
