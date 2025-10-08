import { api } from "/assets/js/api.js";

// Exported so router can call it: router awaits `mod.init(...)` after importing this module.
// (See assets/js/router.js for the dynamic import and named-export call.)
export async function init() {
  // Lightweight loading flag
  try { document.body.classList.add("loading"); } catch {}

  // ——— Local helpers (screen-scoped) ———
  const $ = (id) => document.getElementById(id);

  async function loadMeta() {
    const res = await api("/api/inventory/meta", { method: "GET" });
    if (!res || res.ok === false) throw new Error(res?.error || "meta_failed");
    return res;
  }

  // Generic select filler; supports arrays of strings OR objects
  function fillSelect(selectEl, rows = [], opts = {}) {
    if (!selectEl) return;
    const { textKey = null, valueKey = null, extras = null } = opts;
    selectEl.innerHTML = "";
    for (const row of rows || []) {
      const opt = document.createElement("option");
      const text = textKey ? row?.[textKey] : String(row ?? "");
      const value = valueKey ? row?.[valueKey] : String(row ?? "");
      opt.textContent = text ?? "";
      opt.value = value ?? "";
      if (extras && typeof extras === "function") {
        const ex = extras(row) || {};
        for (const k in ex) opt.dataset[k] = ex[k];
      }
      selectEl.appendChild(opt);
    }
  }

  function ensurePlaceholder(selectEl, placeholderText = "— Select —") {
    if (!selectEl) return;
    const hasOptions = selectEl.options && selectEl.options.length > 0;
    if (hasOptions) return;
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholderText;
    selectEl.appendChild(opt);
    selectEl.value = "";
  }

  // Small no-op wires (safe if elements aren’t present)
  function wireCategoryCodeHint(meta) {
    const sel = $("categorySelect");
    const hint = $("categoryCodeHint");
    if (!sel || !hint) return;
    const update = () => {
      const opt = sel.options[sel.selectedIndex];
      const code = opt?.dataset?.code || "";
      hint.textContent = code ? `Code: ${code}` : "";
    };
    sel.addEventListener("change", update);
    update();
  }

  function wireMarketplaceCategoryPath() {
    const sel = $("marketplaceCategorySelect");
    const pathEl =
      $("marketplaceCategoryPath") ||
      document.querySelector("[data-category-path]") ||
      document.getElementById("categoryPath");
    if (!sel || !pathEl) return;
    const update = () => {
      const opt = sel.options[sel.selectedIndex];
      const path = opt?.dataset?.path || "—";
      pathEl.textContent = path;
    };
    sel.addEventListener("change", update);
    update();
  }

  function wireShippingBoxAutofill(meta) {
    const sel = $("shippingBoxSelect");
    if (!sel) return;
    const lb = $("shipWeightLb");
    const oz = $("shipWeightOz");
    const len = $("shipLength");
    const wid = $("shipWidth");
    const hei = $("shipHeight");
    const map = Object.create(null);
    for (const r of meta.shipping_boxes || []) {
      map[r.box_name] = {
        lb: r.weight_lb ?? "",
        oz: r.weight_oz ?? "",
        len: r.length ?? "",
        wid: r.width ?? "",
        hei: r.height ?? "",
      };
    }
    const update = () => {
      const key = sel.value;
      const m = map[key];
      if (!m) return;
      if (lb) lb.value = m.lb;
      if (oz) oz.value = m.oz;
      if (len) len.value = m.len;
      if (wid) wid.value = m.wid;
      if (hei) hei.value = m.hei;
    };
    sel.addEventListener("change", update);
    update();
  }

  // --- Validation helpers (unchanged) ---
  function getEl(id) { try { return document.getElementById(id); } catch { return null; } }
  function nonEmptySelect(el) { return !!el && el.value !== ""; }
  function markValidity(el, ok) { if (!el) return; el.setAttribute("aria-invalid", ok ? "false" : "true"); }
  function setCtasEnabled(isValid) {
    ["intake-submit", "intake-save", "intake-next"].forEach((id) => {
      const btn = getEl(id);
      if (btn) btn.disabled = !isValid;
    });
  }
  function marketplaceActive() {
    const sales = getEl("salesChannelSelect");
    const v = (sales?.value || "").toLowerCase();
    return v.includes("marketplace") || v.includes("both");
  }
  function computeValidity() {
    const cat = getEl("categorySelect");
    const store = getEl("storeLocationSelect");
    const sales = getEl("salesChannelSelect");

    const reqBase = [
      [cat, nonEmptySelect(cat)],
      [store, nonEmptySelect(store)],
      [sales, nonEmptySelect(sales)],
    ];

    let allOk = reqBase.every(([, ok]) => ok);
    reqBase.forEach(([el, ok]) => markValidity(el, ok));

    if (marketplaceActive()) {
      const mcat = getEl("marketplaceCategorySelect");
      const cond = getEl("conditionSelect");
      const brand = getEl("brandSelect");
      const color = getEl("colorSelect");

      const reqMk = [
        [mcat, nonEmptySelect(mcat)],
        [cond, nonEmptySelect(cond)],
        [brand, nonEmptySelect(brand)],
        [color, nonEmptySelect(color)],
      ];
      allOk = allOk && reqMk.every(([, ok]) => ok);
      reqMk.forEach(([el, ok]) => markValidity(el, ok));
    } else {
      ["marketplaceCategorySelect", "conditionSelect", "brandSelect", "colorSelect"].forEach((id) => {
        const el = getEl(id);
        if (el) el.setAttribute("aria-invalid", "false");
      });
    }

    setCtasEnabled(allOk);
    document.dispatchEvent(new CustomEvent("intake:validity-changed", { detail: { valid: allOk } }));
    return allOk;
  }
  function wireValidation() {
    [
      "categorySelect",
      "storeLocationSelect",
      "salesChannelSelect",
      "marketplaceCategorySelect",
      "conditionSelect",
      "brandSelect",
      "colorSelect",
    ].forEach((id) => {
      const el = getEl(id);
      if (el) el.addEventListener("change", computeValidity);
    });
  }
  // --- end validation helpers ---

  try {
    const meta = await loadMeta();

    // Populate Category (+ show its code hint)
    fillSelect($("categorySelect"), meta.categories, {
      textKey: "category_name",
      valueKey: "category_name",
      extras: (row) => ({ code: row.category_code }),
    });
    wireCategoryCodeHint(meta);

    // Marketplace lists
    fillSelect($("marketplaceCategorySelect"), meta.marketplace.categories, {
      textKey: "display_name",
      valueKey: "display_name",
      extras: (row) => ({ path: row.path || "" }),
    });
    wireMarketplaceCategoryPath();

    fillSelect($("brandSelect"), meta.marketplace.brands);
    fillSelect($("conditionSelect"), meta.marketplace.conditions);
    fillSelect($("colorSelect"), meta.marketplace.colors);

    // Shipping
    fillSelect($("shippingBoxSelect"), meta.shipping_boxes, {
      textKey: "box_name",
      valueKey: "box_name",
    });
    wireShippingBoxAutofill(meta);

    // Store + channel
    fillSelect($("storeLocationSelect"), meta.store_locations);
    fillSelect($("salesChannelSelect"), meta.sales_channels);

    // Apply placeholders if any list was empty
    ensurePlaceholder($("categorySelect"));
    ensurePlaceholder($("marketplaceCategorySelect"));
    ensurePlaceholder($("brandSelect"));
    ensurePlaceholder($("conditionSelect"));
    ensurePlaceholder($("colorSelect"));
    ensurePlaceholder($("shippingBoxSelect"));
    ensurePlaceholder($("storeLocationSelect"));
    ensurePlaceholder($("salesChannelSelect"));

    // Wire and run initial validation
    wireValidation();
    computeValidity();
  } catch (err) {
    console.error("Meta load failed:", err);
    const denied = document.getElementById("intake-access-denied");
    if (denied) denied.classList.remove("hidden");
  } finally {
    try { document.body.classList.remove("loading"); } catch {}
  }
}
