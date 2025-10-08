async function init() {
  await ensure();
  disableWrites();

  // —— Local helpers used by this screen (keeps us self-contained) ——
  const $ = (id) => document.getElementById(id);
  async function loadMeta() {
    // use centralized API helper; returns parsed JSON
    const res = await api("/api/inventory/meta", { method: "GET" });
    if (!res || res.ok === false) {
      throw new Error(res?.error || "meta_failed");
    }
    return res;
  }

  try { document.body.classList.add('loading'); } catch {}

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

  // --- Validation helpers (dropdown-only gating) ---
  function getEl(id) { try { return document.getElementById(id); } catch { return null; } }
  function nonEmptySelect(el) { return !!el && el.value !== ""; }
  function markValidity(el, ok) { if (!el) return; el.setAttribute("aria-invalid", ok ? "false" : "true"); }
  function setCtasEnabled(isValid) {
    const ids = ["intake-submit", "intake-save", "intake-next"];
    ids.forEach((id) => {
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
      ["marketplaceCategorySelect","conditionSelect","brandSelect","colorSelect"].forEach((id) => {
        const el = getEl(id);
        if (el) el.setAttribute("aria-invalid", "false");
      });
    }

    setCtasEnabled(allOk);
    document.dispatchEvent(new CustomEvent("intake:validity-changed", { detail: { valid: allOk } }));
    return allOk;
  }
  function wireValidation() {
    const ids = [
      "categorySelect",
      "storeLocationSelect",
      "salesChannelSelect",
      "marketplaceCategorySelect",
      "conditionSelect",
      "brandSelect",
      "colorSelect",
    ];
    ids.forEach((id) => {
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
    const denied = $("intake-access-denied");
    if (denied) denied.classList.remove("hidden");
  } finally {
    try { document.body.classList.remove('loading'); } catch {}
  }
}
