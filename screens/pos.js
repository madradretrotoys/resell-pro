// POS Screen (Cloudflare + Neon)
import { ensureSession } from "../assets/js/auth.js";
import { api } from "../assets/js/api.js";
import { showToast, applyButtonGroupColors, wireInventoryImageLightbox } from "../assets/js/ui.js"; // ui.js exports
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
    ticketDiscountInput: root.querySelector("#pos-ticket-discount-input"),
    ticketDiscountApply: root.querySelector("#pos-ticket-discount-apply"),
    ticketDiscountMode: root.querySelectorAll("input[name='pos-ticket-discount-mode']"),
    ticketEmpty: root.querySelector("#pos-ticket-empty"),
    // totals
    subtotal: root.querySelector("#pos-subtotal"),
    discounts: root.querySelector("#pos-discounts"),
    tax: root.querySelector("#pos-tax"),
    total: root.querySelector("#pos-total"),
    // payment row
    payment: root.querySelector("#pos-payment"),
    split: root.querySelector("#pos-split"),
    customer: root.querySelector("#pos-customer"),
    complete: root.querySelector("#pos-complete"),
    // cash panel
    cashPanel: root.querySelector("#pos-cash-panel"),
    cashClose: root.querySelector("#pos-cash-close"),
    cashTotalTxt: root.querySelector("#pos-cash-total-txt"),
    cashReceived: root.querySelector("#pos-cash-received"),
    cashChangeTxt: root.querySelector("#pos-cash-change-txt"),
    cashConfirm: root.querySelector("#pos-cash-confirm"),
    // split panel
    splitPanel: root.querySelector("#pos-split-panel"),
    splitClose: root.querySelector("#pos-split-close"),
    splitTable: root.querySelector("#pos-split-table"),
    splitBody: root.querySelector("#pos-split-body"),
    splitMethod: root.querySelector("#pos-split-method"),
    splitAmount: root.querySelector("#pos-split-amount"),
    splitAdd: root.querySelector("#pos-split-add"),
    splitRemaining: root.querySelector("#pos-split-remaining"),
    splitConfirm: root.querySelector("#pos-split-confirm"),
    // logs
    logs: root.querySelector("#pos-logs"),
    // sales
    salesToday: root.querySelector("#pos-sales-today"),
    dateFrom: root.querySelector("#pos-date-from"),
    dateTo: root.querySelector("#pos-date-to"),
    salesLoad: root.querySelector("#pos-sales-load"),
    salesBody: root.querySelector("#pos-sales-body"),

    // VALOR status / fallback
    valorBar: root.querySelector("#pos-valor-bar"),
    valorMsg: root.querySelector("#pos-valor-msg"),
    valorFinalize: root.querySelector("#pos-valor-finalize"),
    // --- VALOR force-finalize modal ---
    valorModal: root.querySelector("#pos-valor-modal"),
    valorModalText: root.querySelector("#pos-valor-modal-text"),
    valorModalInvoice: root.querySelector("#pos-valor-invoice"),
    valorModalAmount: root.querySelector("#pos-valor-amount"),
    valorApprove: root.querySelector("#pos-valor-approve"),
    valorRetry: root.querySelector("#pos-valor-retry"),
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

    // Server-driven tax (falls back to state.taxRate default if absent)
    const mRate = Number(meta.tax_rate);
    if (Number.isFinite(mRate) && mRate > 0) state.taxRate = mRate;

    // Valor config (used by the Complete Sale flow for card payments)
    state.valor = {
      enabled: !!meta.valor_enabled,
      environment: meta.valor_environment || "production",
      ackTimeoutMs: Number(meta.valor_ack_timeout_ms ?? 12000),
      pollIntervalMs: Number(meta.valor_poll_interval_ms ?? 1200),
      pollTimeoutMs: Number(meta.valor_poll_timeout_ms ?? 40000),
    };
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
    // NEW: show today's sales automatically on boot
    try { await loadSales({ preset: "today" }); } catch {}

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
      state.items.unshift({
        sku: null,
        name: "Misc item",
        price: 0,
        qty: 1,
        discount: { mode: "percent", value: 0 }
      });
      render();
    
     // Put the caret in the newly-added Misc price field so you can type immediately
      // NOTE: items are newest-first, so the new Misc row is the FIRST data-price input.
      const priceInputs = el.cart.querySelectorAll("[data-price]");
      const first = priceInputs[0];
      if (first) {
        first.scrollIntoView({ behavior: "smooth", block: "nearest" });
        first.focus();
        first.select?.();
      }
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
  
   // ---- UI LOCK / PAYMENT UNLOCK / RESET ----
  function setPaymentControlsEnabled(on) {
    // Only payment row (retry after a decline, cart stays frozen)
    if (el.payment) el.payment.disabled = !on;
    if (el.split) el.split.disabled = !on;
    if (el.complete) el.complete.disabled = !on;
    if (el.cashClose) el.cashClose.disabled = !on;
    if (el.cashConfirm) el.cashConfirm.disabled = !on;
    if (el.splitAdd) el.splitAdd.disabled = !on;
    if (el.splitConfirm) el.splitConfirm.disabled = !on;
  }
  
  function setUiLocked(on) {
    state.uiLocked = !!on;
  
    // Search / results
    if (el.q) el.q.disabled = on;
    if (el.qBtn) el.qBtn.disabled = on;
    if (el.qClear) el.qClear.disabled = on;
    if (el.quickMisc) el.quickMisc.disabled = on;
    // disable “Add” buttons in results
    el.results?.querySelectorAll("button").forEach(b => b.disabled = on);
  
    // Ticket-level actions
    if (el.ticketEmpty) el.ticketEmpty.disabled = on;
    if (el.discountApply) el.discountApply.disabled = on;
  
    // Payment row (will be re-enabled selectively on decline)
    setPaymentControlsEnabled(!on);
  
    // Dynamic cart controls (render will re-bind, but clamp now too)
    el.cart?.querySelectorAll("[data-qty],[data-remove],[data-price],[data-apply-discount]")
      .forEach(n => { n.disabled = on; n.setAttribute("aria-disabled", String(on)); });
  
    // Visual busy hint on the main button
    if (el.complete) {
      el.complete.setAttribute("aria-busy", on ? "true" : "false");
    }
  }
  
  function hideValorModal() {
    if (!el.valorModal) return;
  
    // Properly close <dialog> so its backdrop stops intercepting clicks
    if (typeof el.valorModal.close === "function") {
      try {
        el.valorModal.close();
      } catch {
        // ignore if already closed
      }
    }
  
    // Fallback for non-<dialog> environments
    el.valorModal.style.display = "none";
  }
  
  async function resetScreen() {
    // Cancel any pending force-finalize timer between sales
    if (window.__ffTimerHandle) { clearTimeout(window.__ffTimerHandle); window.__ffTimerHandle = null; }
    
    // Clear all transient UI and state to prepare for next sale
    //if (el.valorModal) el.valorModal.style.display = "none";

    // Clear all transient UI and state to prepare for next sale
    hideValorModal();
    
    if (el.valorBar) el.valorBar.classList.add("hidden");
    if (el.banner) {
      el.banner.classList.add("hidden");
      el.banner.innerHTML = "";
    }

    // 🔹 PHASE-1: also clear the Search pane so the next sale starts clean
    if (el.q) el.q.value = "";
    if (el.results) el.results.innerHTML = "";
    // return focus to the search box for fast scanning/entry
    setTimeout(() => el.q?.focus?.(), 0);
    
    // Clear cart & state
    state.items = [];
    state.payment = null;
    state.invoice = null;
    state.splitParts = [];
    state.cardSeqIndex = -1; // ensure new sale starts with no active card slice
  
    // Fully reset PAYMENT UI (dropdown, panels, and any disabled controls)
    if (el.payment) el.payment.value = "";                  // back to "Select payment…"
    if (el.complete) {
      el.complete.disabled = true;                          // requires a payment + at least one item
      el.complete.classList.remove("btn-success");
      el.complete.classList.add("btn-primary");
    }
    // Cash panel → hide + re-enable inputs/buttons
    if (el.cashPanel) el.cashPanel.style.display = "none";
    if (el.cashConfirm) el.cashConfirm.disabled = false;
    if (el.cashReceived) {
      el.cashReceived.disabled = false;
      el.cashReceived.value = "";
    }
    // Split panel → hide + clear working fields + re-enable controls
    if (el.splitPanel) el.splitPanel.style.display = "none";
    if (el.splitAmount) el.splitAmount.value = "";
    if (el.splitMethod) el.splitMethod.value = "cash";
    if (el.splitConfirm) el.splitConfirm.disabled = false;
    if (el.splitMethod) el.splitMethod.disabled = false;
    if (el.splitAmount) el.splitAmount.disabled = false;
    if (el.splitAdd) el.splitAdd.disabled = false;
    el.splitBody?.querySelectorAll("[data-split-remove]").forEach(b => b.disabled = false);
  
    // Ensure the payment row is interactive again
    setPaymentControlsEnabled(true);
    setUiLocked(false);
  
    // Repaint UI from a clean slate
    render();
  
    // Refresh Today list and scroll into view (unchanged)
    try { await loadSales({ preset: "today" }); } catch {}
    document.getElementById("pos-sales")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  
  
  function makeState() {
  return {
    // items: [{ sku, name, price, qty, discount:{mode:'percent'|'amount', value:number} }]
    items: [],
    taxRate: 0.080, // temporary default: 8.0%
    previewEnabled: false, // server preview gate (prevents 405 spam)
    uiLocked: false,        // NEW: global UI lock while a sale is in-flight
    totals: { subtotal: 0, discount: 0, tax: 0, total: 0 },
    // payment UI state
    payment: null,          // e.g., { type:'cash', received, change, amount } or { type:'split', parts:[{method, amount}], total }
    splitParts: [],         // working set for Split modal

    // sequencing for split card flows (-1 = not sequencing; otherwise index in payment.parts)
    cardSeqIndex: -1,
    // ticket-level discount
    ticketDiscount: { mode: "percent", value: 0 },
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

       // Normalize thumbnails: fixed box + object-fit cover, and make clickable
      const img = it.image_url
        ? `<button
             type="button"
             class="inventory-thumb-btn"
             data-image-url="${escapeHtml(it.image_url)}"
           >
             <img
               class="pos-thumb"
               src="${escapeHtml(it.image_url)}"
               alt="Item image"
               width="96"
               height="96"
               loading="lazy"
             >
           </button>`
        : `<div class="pos-thumb pos-thumb--ph" style="width:96px;height:96px;"></div>`;

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

    // Wire the shared inventory image lightbox for the POS results
    wireInventoryImageLightbox(el.results);

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
        state.items.unshift({
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
      const refreshCompleteEnabled = () => {
        const can = !!state.payment && !!state.items.length && !state.uiLocked;
        el.complete.disabled = !can;
        // Green when enabled per spec
        if (can) {
          el.complete.classList.add("btn-success");
          el.complete.classList.remove("btn-primary");
        } else {
          el.complete.classList.remove("btn-success");
        }
      };
      const show = (n) => { if (n) n.style.display = ""; };
      const hide = (n) => { if (n) n.style.display = "none"; };
    
      // Ensure payment panels are hidden on screen load (independent of CSS classes)
      hide(el.cashPanel);
      hide(el.splitPanel);

        // ---------- CASH (panel) ----------
        const fmtMoney = (n) => (Number(n || 0) < 0 ? "-$" : "$") + Math.abs(Number(n || 0)).toFixed(2);
    
        const paintCash = () => {
          const total = Number(state.totals.total || 0);
          const received = Number(el.cashReceived.value || 0);
          const change = Math.max(0, received - total);
          el.cashTotalTxt.textContent = fmtMoney(total);
          el.cashChangeTxt.textContent = fmtMoney(change);
        };
    
        const openCash = () => {
          el.cashReceived.value = "";
          paintCash();
          show(el.cashPanel);
          hide(el.splitPanel);
          setTimeout(() => el.cashReceived?.focus?.(), 0);
        };
    
        const closeCash = () => hide(el.cashPanel);
    
        el.payment.addEventListener("change", () => {
          const v = el.payment.value;
          if (v === "cash") {
            openCash();
            state.payment = null; // wait for confirm
          } else if (v) {
            // single non-cash method (no processor yet)
            closeCash();
            hide(el.splitPanel);
            state.payment = { type: "single", method: v, amount: Number(state.totals.total || 0) };
          } else {
            closeCash();
            hide(el.splitPanel);
            state.payment = null;
          }
          refreshCompleteEnabled();
        });
    
        el.cashClose.addEventListener("click", () => { closeCash(); el.payment.value = ""; state.payment = null; refreshCompleteEnabled(); });
        el.cashReceived.addEventListener("input", paintCash);
    
        el.cashConfirm.addEventListener("click", () => {
          const total = Number(state.totals.total || 0);
          const received = Number(el.cashReceived.value || 0);
          if (!(received >= total)) {
            showBanner("Amount received must be at least the total due.");
            return;
          }
          const change = Math.max(0, received - total);
          state.payment = { type: "cash", amount: total, received, change };
        
          // Keep panel visible; lock so user sees exactly what will be sent
          el.cashConfirm.disabled = true;
          el.cashReceived.disabled = true;
        
          refreshCompleteEnabled();
        });
    
        // ---------- SPLIT (panel) ----------
        const paintSplitTable = () => {
          el.splitBody.innerHTML = state.splitParts.map((p, i) => `
            <tr>
              <td>${escapeHtml(p.method_label || p.method)}</td>
              <td>${fmtMoney(p.amount)}</td>
              <td><button class="btn btn-xs btn-ghost" data-split-remove="${i}">Remove</button></td>
            </tr>
          `).join("");
    
          const toCents = (x) => Math.round(Number(x || 0) * 100);
          const total = Number(state.totals.total || 0);
          const paid = state.splitParts.reduce((s, p) => s + Number(p.amount || 0), 0);
          const remaining = Math.max(0, total - paid);
          el.splitRemaining.textContent = fmtMoney(remaining);
          el.splitConfirm.disabled = !(toCents(paid) === toCents(total) && state.splitParts.length > 0);

    
          el.splitBody.querySelectorAll("[data-split-remove]").forEach(btn => {
            btn.addEventListener("click", () => {
              const idx = Number(btn.getAttribute("data-split-remove") || -1);
              if (idx >= 0) {
                state.splitParts.splice(idx, 1);
                paintSplitTable();
                refreshCompleteEnabled();
              }
            });
          });
        };
    
        const methodLabel = (v) => {
          const map = {
            "cash": "CASH",
            "card:visa": "Visa (Valor)",
            "card:mastercard": "MasterCard (Valor)",
            "card:amex": "Amex (Valor)",
            "card:discover": "Discover (Valor)",
            "wallet:venmo": "Venmo",
            "wallet:zelle": "Zelle",
            "wallet:cashapp": "Cash App"
          };
          return map[v] || v;
        };
        
        el.split.addEventListener("click", () => {
          hide(el.cashPanel);
          state.splitParts = [];
          el.splitAmount.value = "";
          el.splitMethod.value = "cash";
          paintSplitTable();
          show(el.splitPanel);
          refreshCompleteEnabled();
        });
    
        el.splitClose.addEventListener("click", () => { hide(el.splitPanel); refreshCompleteEnabled(); });
    
        el.splitAdd.addEventListener("click", () => {
          const m = el.splitMethod.value;
          const amt = Number(el.splitAmount.value || 0);
          if (!(amt > 0)) return;
          state.splitParts.push({ method: m, method_label: methodLabel(m), amount: amt });
          el.splitAmount.value = "";
          paintSplitTable();
        });
    
        el.splitConfirm.addEventListener("click", () => {
          const toCents = (x) => Math.round(Number(x || 0) * 100);
          const total = Number(state.totals.total || 0);
          const paid = state.splitParts.reduce((s, p) => s + Number(p.amount || 0), 0);
          if (toCents(paid) !== toCents(total)) return;
        
          state.payment = { type: "split", total, parts: [...state.splitParts] };
        
          // Keep panel visible; lock so user sees exactly what will be sent
          el.splitConfirm.disabled = true;
          el.splitMethod.disabled = true;
          el.splitAmount.disabled = true;
          el.splitAdd.disabled = true;
          el.splitBody.querySelectorAll("[data-split-remove]").forEach(b => b.disabled = true);
        
          el.payment.value = ""; // reflect split (no single method selected)
          refreshCompleteEnabled();
        });
        // --- Ticket-level Discount Apply ---
        el.ticketDiscountApply.addEventListener("click", async () => {
          let mode = "percent";
          el.ticketDiscountMode.forEach(r => {
            if (r.checked) mode = r.value;
          });

          const val = Number(el.ticketDiscountInput.value || 0);

          state.ticketDiscount = {
            mode,
            value: Number.isFinite(val) ? val : 0
          };

          await refreshTotalsViaServer();
        });
        // ---------- COMPLETE ----------
        el.complete.addEventListener("click", async () => {
          if (!state.items.length || !state.payment) return;
          if (!state.payment) { showBanner("Select a payment method."); return; }
          
          //hard lock UI and debounce double-clicks
          setUiLocked(true);
          if (el.complete) el.complete.disabled = true;
        
          

          // Describe the payment succinctly (mirrors the legacy)
          let paymentDesc = "";
          if (state.payment.type === "cash") {
            paymentDesc = `cash:${state.payment.amount.toFixed(2)};received=${state.payment.received.toFixed(2)};change=${state.payment.change.toFixed(2)}`;
          } else if (state.payment.type === "split") {
            paymentDesc = "split:" + state.payment.parts.map(p => `${p.method}:${Number(p.amount).toFixed(2)}`).join(",");
          } else if (state.payment.type === "single") {
            paymentDesc = state.payment.method;
          }

          try {
            // Freeze UI totals exactly as displayed (2-decimals)
            const r2 = (n) => Number.parseFloat(Number(n || 0).toFixed(2));
            
            const enrichLine = (it) => {
              const qty = Math.max(1, Number(it.qty || 0));
              const unit = Number(it.price || 0);
              const mode = (it.discount?.mode || "percent").toLowerCase();
              const val  = Number(it.discount?.value || 0);
              const lineRaw = unit * qty;
              const lineDisc = mode === "percent" ? (lineRaw * (val / 100)) : val;
              return {
                ...it,
                line_discount: r2(Math.min(lineDisc, lineRaw)),       // exact as UI
                line_final:    r2(Math.max(0, lineRaw - lineDisc)),   // exact as UI (pre-tax)
              };
            };
            
            // Decide if this sale includes a card and which slice (if split) we should publish now
            const hasCard =
              (state.payment?.type === "single" && String(state.payment.method || "").startsWith("card:")) ||
              (state.payment?.type === "split"  && Array.isArray(state.payment.parts) && state.payment.parts.some(p => String(p?.method || "").startsWith("card:")));
            
            // For split+card, initialize the sequence to the first card part
            let currentPartIdx = -1;
            if (state.payment?.type === "split" && hasCard) {
              currentPartIdx = Number.isInteger(state.cardSeqIndex) && state.cardSeqIndex >= 0
                ? state.cardSeqIndex
                : state.payment.parts.findIndex(p => String(p?.method || "").startsWith("card:"));
              state.cardSeqIndex = currentPartIdx;
            }
            
            // Compute the amount to PUBLISH on this /start call
            const publishAmount = hasCard
              ? (state.payment?.type === "single"
                  ? Number(state.totals.total || 0)
                  : Number(state.payment.parts?.[currentPartIdx]?.amount || 0))
              : Number(state.totals.total || 0);
            
            const body = {
              // send enriched lines so server stores line_discount + line_final exactly as shown in UI
              items: state.items.map(enrichLine),
              totals: {
                raw_subtotal: r2(state.totals.subtotal || 0),
                line_discounts: r2(state.totals.discount || 0),
                subtotal: r2((state.totals.subtotal || 0) - (state.totals.discount || 0)),
                tax: r2(state.totals.tax || 0),
                total: r2(publishAmount),               // << publish only this slice for card flows
                tax_rate: Number(state.taxRate || 0)
              },
              customer: (el.customer?.value || "").trim() || null,
              payment: paymentDesc,
              // keep full split parts for storage/audit; final write happens after last part
              payment_parts: state.payment?.type === "split" ? state.payment.parts : undefined,
            };
            
            console.group("[POS] checkout/start");
            console.log("[POS] request body", body);
            
            // --- START THE FORCE-FINALIZE TIMER AT CLICK TIME (only for card flows) ---
            if (hasCard) {
              const uiAmount = publishAmount;
              showBanner(`Sent to terminal — waiting for approval (Card ${fmtCurrency(uiAmount)})`);
              el.valorBar?.classList.remove("hidden");
              el.valorMsg.textContent = "Waiting…";
              if (el.valorModalAmount) el.valorModalAmount.textContent = fmtCurrency(uiAmount);
              if (window.__ffTimerHandle) clearTimeout(window.__ffTimerHandle);
              window.__ffTimerHandle = setTimeout(() => {
                if (el.valorModalInvoice) el.valorModalInvoice.textContent = "—";
                if (el.valorModal) {
                  if (el.valorModal.showModal) {
                    el.valorModal.showModal();
                  } else {
                    el.valorModal.style.display = "block";
                  }
                  el.valorModal.focus();
                  el.valorModal.scrollIntoView({ behavior: "smooth", block: "center" });
                }
              }, 10000);
            }
            // --- /timer ---
            
            // --- WIRE BUTTONS NOW (so they work the moment the modal opens) ---
            if (!window.__ffWired) {
              window.__ffWired = true;
            
              const r2 = (n) => Number.parseFloat(Number(n || 0).toFixed(2));
              const enrich = (it) => {
                const qty = Math.max(1, Number(it.qty || 0));
                const unit = Number(it.price || 0);
                const mode = (it.discount?.mode || "percent").toLowerCase();
                const val  = Number(it.discount?.value || 0);
                const raw  = unit * qty;
                const disc = mode === "percent" ? (raw * (val / 100)) : val;
                return { ...it, line_discount: r2(Math.min(disc, raw)), line_final: r2(Math.max(0, raw - disc)) };
              };
            
              // Terminal Approved → advance to next card part, or finalize once when all parts are done
              if (el.valorApprove) el.valorApprove.onclick = async () => {
                setUiLocked(false);
                try {
                  el.valorApprove.disabled = true;
                  el.valorRetry.disabled = true;
                  el.valorMsg.textContent = "Processing…";
              
                  const isSplit = state.payment?.type === "split";
                  if (isSplit && Array.isArray(state.payment.parts)) {
                    // Find the next card:* slice AFTER the current one
                    const parts = state.payment.parts;
                    const start = Number.isInteger(state.cardSeqIndex) ? (state.cardSeqIndex + 1) : 0;
                    let nextIdx = -1;
                    for (let i = start; i < parts.length; i++) {
                      if (String(parts[i]?.method || "").startsWith("card:")) { nextIdx = i; break; }
                    }
              
                    if (nextIdx >= 0) {
                      // Start next card slice: update index, UI, timer, and publish /start with that slice's amount
                      state.cardSeqIndex = nextIdx;
                      const amt = Number(parts[nextIdx]?.amount || 0);
              
                      // UI for this slice
                      showBanner(`Sent to terminal — waiting for approval (Card ${fmtCurrency(amt)})`);
                      el.valorBar?.classList.remove("hidden");
                      el.valorMsg.textContent = "Waiting…";
                      if (el.valorModalAmount) el.valorModalAmount.textContent = fmtCurrency(amt);
              
                      // Restart the timer
                      if (window.__ffTimerHandle) clearTimeout(window.__ffTimerHandle);
                      window.__ffTimerHandle = setTimeout(() => {
                        if (el.valorModalInvoice) el.valorModalInvoice.textContent = "—";
                        if (el.valorModal) {
                          if (el.valorModal.showModal) {
                            el.valorModal.showModal();
                          } else {
                            el.valorModal.style.display = "block";
                          }
                          el.valorModal.focus();
                          el.valorModal.scrollIntoView({ behavior: "smooth", block: "center" });
                        }
                      }, 10000);
              
                      // Publish this slice to /start (override total to the slice amount)
                      const bodySlice = {
                        items: state.items.map(enrich),
                        totals: {
                          raw_subtotal: r2(state.totals.subtotal || 0),
                          line_discounts: r2(state.totals.discount || 0),
                          subtotal: r2((state.totals.subtotal || 0) - (state.totals.discount || 0)),
                          tax: r2(state.totals.tax || 0),
                          total: r2(amt),
                          tax_rate: Number(state.taxRate || 0)
                        },
                        customer: (el.customer?.value || "").trim() || null,
                        payment: "card",
                        payment_parts: parts
                      };
                      try { await api("/api/pos/checkout/start", { method: "POST", json: bodySlice }); } catch {}
              
                      // Allow another Approve/Retry for the next slice
                      el.valorApprove.disabled = false;
                      el.valorRetry.disabled = false;
                      return;
                    }
                  }
              
                  // No more card parts → finalize once with the full snapshot
                  const payload = {
                    items: state.items.map(enrich),
                    totals: {
                      raw_subtotal: r2(state.totals.subtotal || 0),
                      line_discounts: r2(state.totals.discount || 0),
                      subtotal: r2((state.totals.subtotal || 0) - (state.totals.discount || 0)),
                      tax: r2(state.totals.tax || 0),
                      total: r2(state.totals.total || 0),
                      tax_rate: Number(state.taxRate || 0)
                    },
                    payment: "card",
                    payment_parts: state.payment?.type === "split" ? state.payment.parts : undefined
                  };
              
                  console.group("[POS] force-finalize (final)");
                  console.log("[POS] force-finalize payload", payload);
                  const ff = await api("/api/pos/checkout/force-finalize", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(payload)
                  });
                  console.log("[POS] force-finalize response", ff);
                  console.groupEnd();
              
                  if (ff?.sale_id) {
                    state.cardSeqIndex = -1; // clean slate for next sale
                    showBanner(`Sale finalized. Receipt #${escapeHtml(ff.sale_id)}`);
                    await resetScreen();
                  } else {
                    showToast("Finalize failed — server did not return sale_id.");
                  }
                } catch (e) {
                  showToast(`Finalize failed: ${e?.message || e}`);
                } finally {
                  el.valorApprove.disabled = false;
                  el.valorRetry.disabled = false;
                }
              };
            
              // Retry — resend the CURRENT card slice; also unlock UI for edits
              if (el.valorRetry) el.valorRetry.onclick = async () => {
               // Close modal; keep the bar visible while retrying
                hideValorModal();
                el.valorBar?.classList.remove("hidden");
                el.valorMsg.textContent = "Waiting…";
              
                // Allow edits without advancing the slice
                setUiLocked(false);
                render();
              
                // Determine current slice amount
                let amt = 0;
                if (state.payment?.type === "single" && String(state.payment.method || "").startsWith("card:")) {
                  amt = Number(state.totals.total || 0);
                } else if (state.payment?.type === "split" && Array.isArray(state.payment.parts)) {
                  const idx = Number.isInteger(state.cardSeqIndex)
                    ? state.cardSeqIndex
                    : state.payment.parts.findIndex(p => String(p?.method || "").startsWith("card:"));
                  state.cardSeqIndex = idx;
                  amt = Number(state.payment.parts?.[idx]?.amount || 0);
                }
                if (el.valorModalAmount) el.valorModalAmount.textContent = fmtCurrency(amt);
              
                // Restart timer
                if (window.__ffTimerHandle) clearTimeout(window.__ffTimerHandle);
                window.__ffTimerHandle = setTimeout(() => {
                  if (el.valorModalInvoice) el.valorModalInvoice.textContent = "—";
                  if (el.valorModal) el.valorModal.style.display = "";
                }, 10000);
              
                // Publish /start for this slice (override total to slice amount)
                const bodySlice = {
                  items: state.items.map(enrich),
                  totals: {
                    raw_subtotal: r2(state.totals.subtotal || 0),
                    line_discounts: r2(state.totals.discount || 0),
                    subtotal: r2((state.totals.subtotal || 0) - (state.totals.discount || 0)),
                    tax: r2(state.totals.tax || 0),
                    total: r2(amt),
                    tax_rate: Number(state.taxRate || 0)
                  },
                  customer: (el.customer?.value || "").trim() || null,
                  payment: "card",
                  payment_parts: state.payment?.type === "split" ? state.payment.parts : undefined
                };
                try { await api("/api/pos/checkout/start", { method: "POST", json: bodySlice }); } catch {}
              };

            }
            // --- /wire buttons ---
            
            let res;
            try {
              res = await api("/api/pos/checkout/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
              });
              console.log("[POS] response", res);
            } catch (err) {
              console.error("[POS] start failed", err);
              throw err; // keep existing banner behaviour
            } finally {
              console.groupEnd();
            }
            
            log(res);

            if (res?.status === "completed" && res?.sale_id) {
              // Hard-cancel any pending Valor timer in case it was set earlier
              if (window.__ffTimerHandle) { clearTimeout(window.__ffTimerHandle); window.__ffTimerHandle = null; }
              // Ensure Valor UI stays hidden for non-card flows
              if (el.valorBar) el.valorBar.classList.add("hidden");
              hideValorModal();
              
              
              state.cardSeqIndex = -1; // clean slate for next sale
              showBanner(`Sale completed. Receipt #${escapeHtml(res.sale_id)}`);
              await resetScreen();
              return;
            }

            // Card flow (no polling; handlers were wired at click time)
            if (res?.status === "waiting_for_valor" && res?.invoice) {
              el.banner.classList.remove("hidden");
              el.banner.innerHTML = `<div class="card p-2">Sale started — you can force finalize if terminal shows Approved.</div>`;
              el.valorBar?.classList.remove("hidden");
              el.valorMsg.textContent = "Waiting…";
              if (el.valorModalInvoice) el.valorModalInvoice.textContent = "—";
            
              // Keep the modal showing the current slice amount (matches the publishAmount used above)
              let uiAmount = Number(state.totals.total || 0);
              if (state.payment?.type === "split" && Number.isInteger(state.cardSeqIndex) && state.cardSeqIndex >= 0) {
                uiAmount = Number(state.payment.parts?.[state.cardSeqIndex]?.amount || uiAmount);
              }
              if (el.valorModalAmount) el.valorModalAmount.textContent = fmtCurrency(uiAmount);
            
              // Do NOT set timers, do NOT bind buttons, do NOT poll here.
              return;
            }

            // Fallback for unexpected response
            el.banner.classList.remove("hidden");
            el.banner.innerHTML = `<div class="card p-2">Checkout started. Waiting on processor…</div>`;
          } catch (err) {
            el.banner.classList.remove("hidden");
            el.banner.innerHTML = `<div class="card p-2">Checkout failed: ${escapeHtml(err?.message || String(err))}</div>`;
          }
        });
    
        // Keep cash totals display fresh if panel is open when totals change
        const origPaintTotals = paintTotals;
        const self = this;
        paintTotals = function() {
          origPaintTotals.call(self);
          if (el.cashPanel && el.cashPanel.style.display !== "none") paintCash();
        };
    
        refreshCompleteEnabled();
  }


  function wireSales() {
    // One-time: lock Sales layout so the Payment column can wrap
    // and the table can’t auto-grow past the card.
    const salesCardEl  = el.salesBody?.closest(".card");
    const salesTableEl = el.salesBody?.closest("table");
    if (salesCardEl)  salesCardEl.classList.add("pos-sales-card");   // enables scoped widths + overflow guard
    if (salesTableEl) salesTableEl.classList.add("table", "table-fixed"); // fixed layout + base table styling
  
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
      // build all rows
      let html = rows
        .map((r) => {
          return `<tr>
            <td class="whitespace-nowrap">${escapeHtml(r.time)}</td>
            <td class="whitespace-nowrap">${escapeHtml(r.sale_id)}</td>
            <td class="align-top">
              <div class="text-sm pos-wrap">
                ${escapeHtml(r.payment || "")}
              </div>
            </td>
            <td class="whitespace-nowrap">${fmtCurrency(r.total || 0)}</td>
            <td class="whitespace-nowrap">
              <button class="btn btn-xs" data-copy='${r.sale_id}'>Copy total</button>
              <button class="btn btn-xs btn-ghost" data-refund='${r.sale_id}'>Refund…</button>
            </td>
          </tr>`;
        })
        .join("");
      
      // compute grand total
      const grand = rows.reduce((sum, r) => sum + Number(r.total || 0), 0);
      
      // append TOTAL row
      html += `
        <tr class="font-semibold border-t">
          <td colspan="3" class="text-right pr-4">Grand Total:</td>
          <td class="whitespace-nowrap">${fmtCurrency(grand)}</td>
          <td></td>
        </tr>
      `;
      
      el.salesBody.innerHTML = html;
    } catch (err) {
      log(`sales load failed: ${err?.message || err}`);
    }
  }

  function cartRow(it, idx) {
    const isMisc = !it.sku;
    const metaParts = [];
    if (it.sku) metaParts.push(it.sku);
    // Only show the unit price in meta for inventoried items
    if (it.sku && typeof it.price === "number") metaParts.push(fmtCurrency(it.price));
    if (it.inventory_qty) metaParts.push(`Qty:${it.inventory_qty}`);
    if (it.instore_loc) metaParts.push(it.instore_loc);
    if (it.case_bin_shelf) metaParts.push(it.case_bin_shelf);
    const meta = metaParts.join(" · ");
  
    const modePercent = !it.discount || it.discount.mode === "percent";
    const discVal = (it.discount?.value ?? 0);
  
    const priceCell = isMisc
      ? `<input type="number" inputmode="decimal" step="0.01" min="0"
           class="input input-sm w-[88px] text-right"
           value="${Number(it.price || 0).toFixed(2)}"
           data-price="${idx}" />`
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
          <div class="ticket-qty">
            <button class="btn btn-xs" data-qty="${idx}|-">−</button>
            <span class="ticket-qty-val">${it.qty}</span>
            <button class="btn btn-xs" data-qty="${idx}|+">+</button>
          </div>
        </div>
  
        <!-- ROW 2: controls (QTY stacked above Price at far right, then total + remove) -->
        <div class="ticket-controls ticket-controls--item">
          <div class="ticket-controls-left"></div>
        
          <div class="ticket-controls-right">
            <div class="ticket-qty-price">
              
        
              <div class="ticket-price">
                ${priceCell}
              </div>
            </div>
        
            <div class="ticket-line-total text-right">${lineTotal}</div>
        
            <button class="btn btn-danger btn-xs" data-remove="${idx}" ${state.uiLocked ? "disabled aria-disabled='true'" : ""}>Remove</button>
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
          <button class="btn btn-primary btn-sm" data-apply-discount="${idx}">Apply</button>
        </div>
      </div>
    `;
  }    



  function render() {
    // cart list
    el.cart.innerHTML = state.items.map(cartRow).join("");

    // NEW: enforce lock on newly rendered controls
    if (state.uiLocked) {
      el.cart.querySelectorAll("[data-qty],[data-remove],[data-price],[data-apply-discount]")
        .forEach(n => { n.disabled = true; n.setAttribute("aria-disabled", "true"); });
    }

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
      // Commit on change/blur; support values like ".99" by normalizing to "0.99"
      const commit = async () => {
        const idx = Number(inp.getAttribute("data-price"));
        let raw = (inp.value || "").trim();
    
        // Ignore empty/placeholder states
        if (raw === "" || raw === ".") return;
    
        // Normalize leading-decimal forms (".6" -> "0.6", ".99" -> "0.99")
        if (/^\.\d{1,2}$/.test(raw)) raw = "0" + raw;
    
        // Accept up to 2 decimals; "12", "12.", "12.3", "12.34", and "0.99"
        if (!/^\d+(\.\d{0,2})?$/.test(raw)) return;
    
        const val = parseFloat(raw);
        if (!Number.isFinite(val)) return;
    
        state.items[idx].price = val;
    
        // Re-render and refresh totals after the user finishes typing
        render();
        await refreshTotalsViaServer();
      };
    
      inp.addEventListener("change", commit);
      inp.addEventListener("blur", commit);
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
      
      // Line-level discounts
      for (const it of state.items) {
        const line = (it.price || 0) * (it.qty || 0);
        subtotal += line;
      
        const d = it.discount || { mode: "percent", value: 0 };
        const ld =
          d.mode === "percent"
            ? (line * (Number(d.value || 0) / 100))
            : Number(d.value || 0);
      
        discountTotal += Math.min(ld, line);
      }
      
      // Ticket-level discount
      let taxable = Math.max(0, subtotal - discountTotal);
      
      if (state.ticketDiscount) {
        const t = state.ticketDiscount;
        let td = 0;
      
        if (t.mode === "percent") {
          td = taxable * (t.value / 100);
        } else {
          td = t.value;
        }
      
        td = Math.min(td, taxable);
        discountTotal += td;
        taxable = Math.max(0, taxable - td);
      }
      
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
        const body = {
          items: state.items,
          ticket_discount: state.ticketDiscount
        };
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
