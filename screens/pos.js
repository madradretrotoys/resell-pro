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
    state.previewEnabled = !!meta.preview_enabled;
    const mRate = Number(meta.tax_rate);
    if (Number.isFinite(mRate) && mRate > 0) state.taxRate = mRate;
  } catch (err) {
    log(`meta error: ${err?.message || err}`);
    // non-fatal; we’ll render with safe defaults
  } finally {
    // Always clear the spinner and render the screen
    swap("content");
    wireSearch();
    wireCart();
    wireTotals();
    wireSales();
    render();
  }

  // ————— helpers —————
  function wireSearch() {
    // Search button + Enter key
    el.qBtn.addEventListener("click", () => doSearch());
    el.q.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    // Clear
    el.qClear.addEventListener("click", () => {
      el.q.value = "";
      el.results.innerHTML = "";
    });
    // + Misc (adds a custom line so ticket UI can be tested without search)
    el.quickMisc.addEventListener("click", () => {
      state.items.push({
        sku: null,
        name: "Misc item",
        price: 0,
        qty: 1,
        discount: { mode: "percent", value: 0 }
      });
      render();
    });
  }

 function swap(which) {
    // Use explicit display control so banners never "bleed through" on boot
    const set = (el, show) => { if (!el) return; el.style.display = show ? "" : "none"; };
    set(el.banner, false);
    set(el.denied, false);
    set(el.loading, false);
    set(el.content, false);
    if (which === "denied") set(el.denied, true);
    if (which === "loading") set(el.loading, true);
    if (which === "content") set(el.content, true);
  }

  function makeState() {
    return {
      // items: [{ sku, name, price, qty, discount:{mode:'percent'|'amount', value:number} }]
      items: [],
      taxRate: 0.080, // temporary default: 8.0%
      previewEnabled: false, // server preview gate (prevents 405 spam)
      totals: { subtotal: 0, discount: 0, tax: 0, total: 0 },
    };
  }

  function wireCart() {
    el.ticketEmpty.addEventListener("click", () => {
      state.items = [];
      render();
    });

    // per-item handlers are delegated in render() via [data-qty], [data-remove], [data-apply-discount]
  }

  async function doSearch() {
    const q = (el.q.value || "").trim();
    if (!q) {
      log(`[pos.ui] search: empty q — skipping`);
      console.log("[pos.ui] search: empty q — skipping");
      return;
    }

    el.results.innerHTML = `<div class="text-sm text-muted">Searching…</div>`;
    log(`[pos.ui] search: start q="${q}"`);
    console.log("[pos.ui] search: start", { q });

    try {
      // New endpoint: searches app.inventory (sku, category_nm, product_short_title), joins primary image
      const url = `/api/pos/search?q=${encodeURIComponent(q)}`;
      const res = await api(url, { method: "GET" });

      console.log("[pos.ui] search: response", res);
      log(`[pos.ui] search: ok=${!!res?.ok} items=${(res?.items || res?.rows || []).length}`);

      const items = res?.items || res?.rows || [];
      if (!items.length) {
        console.log("[pos.ui] search: no results");
      } else {
        console.log("[pos.ui] search: first item", items[0]);
      }
      renderResults(items);
    } catch (err) {
      el.results.innerHTML = `<div class="text-danger text-sm">Search failed</div>`;
      const msg = err?.message || String(err);
      log(`[pos.ui] search: error ${msg}`);
      console.error("[pos.ui] search: error", err);
    }
  }

  function renderResults(items) {
    if (!items.length) {
      el.results.innerHTML = `<div class="text-sm text-muted">No items found</div>`;
      return;
    }

    el.results.innerHTML = items.map((it) => {
      // API returns: item_id, sku, product_short_title, price, qty, instore_loc, case_bin_shelf, image_url
      const meta = [
        it.sku ? String(it.sku) : "",
        typeof it.price === "number" ? fmtCurrency(it.price) : "",
        (typeof it.qty === "number" ? `Qty: ${it.qty}` : ""),
        (it.instore_loc || ""),
        (it.case_bin_shelf || "")
      ].filter(Boolean).join(" · ");

      const img = it.image_url ? `<img class="pos-thumb" src="${escapeHtml(it.image_url)}" alt="">` :
                                 `<div class="pos-thumb pos-thumb--ph"></div>`;

      return `
        <div class="pos-result-row">
          <div class="pos-result-left">
            ${img}
            <div class="min-w-0">
              <div class="font-medium truncate">${escapeHtml(it.product_short_title || it.name || "")}</div>
              <div class="text-xs muted truncate">${escapeHtml(meta)}</div>
            </div>
          </div>
          <button class="btn btn-sm btn-primary"
            data-add='${JSON.stringify({
              sku: it.sku ?? null,
              name: it.product_short_title || it.name || "",
              price: it.price ?? 0,
              qty: it.qty ?? 0,                     // on-hand (for cap)
              instore_loc: it.instore_loc || "",    // e.g., rm2
              case_bin_shelf: it.case_bin_shelf || "" // e.g., 15
            }).replaceAll("'", "&apos;")}'>Add</button>
        </div>`;
    }).join("");

    el.results.onclick = (e) => {
      const btn = e.target.closest("button[data-add]");
      if (!btn) return;
      const data = JSON.parse(btn.getAttribute("data-add"));
      const found = state.items.find((x) => x.sku && data.sku && x.sku === data.sku);
      
      if (found) {
        const max = Number(found.inventory_qty || 0);
        if (max && found.qty >= max) {
          showBanner(`Only ${max} in stock for ${escapeHtml(found.sku)}. To sell more, add a Misc line.`);
          return;
        }
        found.qty += 1;
        render();               // ensure the visible qty updates immediately
      } else {
        state.items.push({
          ...data,
          qty: 1,
          discount: { mode: "percent", value: 0 },
          inventory_qty: Number(data.qty || 0),
          instore_loc: data.instore_loc || "",
          case_bin_shelf: data.case_bin_shelf || ""
        });
        render();
      }
    };
  }


  

  function wireTotals() {
    el.complete.addEventListener("click", async () => {
      if (!state.items.length) return;
      const payment = el.payment.value;
      if (!payment) return;
      try {
        const body = {
          items: state.items,                     // items carry their own {discount}
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
    const isMisc = !it.sku;
    const metaParts = [];
    if (it.sku) metaParts.push(it.sku);
    if (typeof it.price === "number") metaParts.push(fmtCurrency(it.price));
    if (it.inventory_qty) metaParts.push(`Qty:${it.inventory_qty}`);
    if (it.instore_loc) metaParts.push(it.instore_loc);
    if (it.case_bin_shelf) metaParts.push(it.case_bin_shelf);
    const meta = metaParts.join(" · ");
  
    const modePercent = !it.discount || it.discount.mode === "percent";
    const discVal = (it.discount?.value ?? 0);
  
    const priceCell = isMisc
      ? `<input class="input input-sm w-[88px] text-right" value="${Number(it.price || 0)}" data-price="${idx}" />`
      : `<div class="w-[88px] text-right font-medium">${fmtCurrency(it.price)}</div>`;
  
    const lineTotal = fmtCurrency(
      (it.price || 0) * (it.qty || 0) -
      (it.discount?.mode === "percent"
        ? ((it.price || 0) * (it.qty || 0) * (it.discount?.value || 0) / 100)
        : (it.discount?.value || 0))
    );
  
    return `
      <div class="ticket-row border rounded p-2">
        <!-- ROW 1: product title and meta -->
        <div class="flex flex-col gap-0.5 mb-1">
          <div class="font-medium truncate">${escapeHtml(it.name)}</div>
          <div class="text-xs muted truncate">${escapeHtml(meta)}</div>
        </div>
  
        <!-- ROW 2: controls (qty, discount, total, remove) -->
        <div class="ticket-controls flex items-center justify-between gap-2 flex-wrap">
          <div class="inline-flex items-center gap-1">
            <button class="btn btn-xs" data-qty="${idx}|-">−</button>
            <span class="w-8 text-center">${it.qty}</span>
            <button class="btn btn-xs" data-qty="${idx}|+">+</button>
          </div>
  
          <div class="flex items-center gap-2 flex-1 justify-end flex-wrap">
            <div class="ticket-line-total text-right">${lineTotal}</div>
            <button class="btn btn-ghost btn-xs" data-remove="${idx}">Remove</button>
          </div>
        </div>
  
        <!-- ROW 3: discount (single line; Apply at far right) -->
        <div class="mt-2 discount-row">
          <span class="text-sm text-muted">Discount</span>
          <div class="flex items-center gap-2">
            <label class="inline-flex items-center gap-1">
              <input type="radio" name="pos-discount-mode-${idx}" value="percent" ${modePercent ? "checked" : ""} />
              <span>%</span>
            </label>
            <label class="inline-flex items-center gap-1">
              <input type="radio" name="pos-discount-mode-${idx}" value="amount" ${!modePercent ? "checked" : ""} />
              <span>$</span>
            </label>
          </div>
          <input class="input input-sm w-[120px]" id="pos-discount-input-${idx}" value="${discVal}" placeholder="${modePercent ? 'Enter percent' : 'Enter dollars'}" />
          <button class="btn btn-primary btn-sm push" data-apply-discount="${idx}">Apply</button>
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
      
          const delta = (op === "+") ? 1 : -1;
          let nextQty = Math.max(1, Number(item.qty || 1) + delta);
      
          // Cap to on-hand for inventoried items (misc has no cap)
          const max = Number(item.inventory_qty || 0);
          if (op === "+" && item.sku && max && nextQty > max) {
            showBanner(`Only ${max} in stock for ${escapeHtml(item.sku)}. To sell more, add a Misc line.`);
            return; // do not change qty
          }
      
          item.qty = nextQty;
      
          // Immediately re-render so the visible qty changes from "1"
          render();
      
          // Then ask server for previewed totals (tax, etc.)
          await refreshTotalsViaServer();
        });
      });

  
      el.cart.querySelectorAll("[data-apply-discount]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const idx = Number(btn.getAttribute("data-apply-discount"));
          const row = el.cart.querySelector(`#pos-discount-input-${idx}`);
          const mode = (el.cart.querySelector(`input[name="pos-discount-mode-${idx}"]:checked`)?.value) || "percent";
          const val = Number(row?.value || 0);
          if (!state.items[idx]) return;
          state.items[idx].discount = { mode, value: isFinite(val) ? val : 0 };
          // Repaint row so the right-side line total updates immediately
          render();
          await refreshTotalsViaServer();
        });
      });

      el.cart.querySelectorAll("[data-price]").forEach((inp) => {
        inp.addEventListener("input", async () => {
          const idx = Number(inp.getAttribute("data-price"));
          const val = Number(inp.value || 0);
          if (!isFinite(val)) return;
          state.items[idx].price = val;
          await refreshTotalsViaServer();
        });
      });

      el.cart.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const idx = Number(btn.getAttribute("data-remove"));
          if (!Number.isInteger(idx)) return;
          state.items.splice(idx, 1);
          render();
          await refreshTotalsViaServer();
        });
      });
    
      // totals (client fallback until server calculates)
      computeTotalsClient();
      paintTotals();
    }
  
    function computeTotalsClient() {
      let subtotal = 0, discountTotal = 0;
      for (const it of state.items) {
        const line = (it.price || 0) * (it.qty || 0);
        subtotal += line;
        const d = it.discount || { mode: "percent", value: 0 };
        const ld = d.mode === "percent" ? (line * (Number(d.value || 0) / 100)) : Number(d.value || 0);
        discountTotal += Math.min(ld, line);
      }
      const taxable = Math.max(0, subtotal - discountTotal);
      const tax = taxable * Number(state.taxRate || 0);
      const total = taxable + tax;
      state.totals = { subtotal, discount: discountTotal, tax, total };
    }


    async function refreshTotalsViaServer() {
      if (!state.previewEnabled) {
        // Use client math only; keep console clean (no 405s)
        computeTotalsClient();
        paintTotals();
        return;
      }
    
      try {
        const body = { items: state.items };
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

  function showBanner(message) {
    el.banner.classList.remove("hidden");
    el.banner.innerHTML = `<div class="card p-2">${escapeHtml(message || "")}</div>`;
  }
  
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
}
