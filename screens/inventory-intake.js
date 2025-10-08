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

    setCtasEnabled
