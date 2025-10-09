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

  // Generic select filler; supports arrays of strings OR objects.
  // Adds a placeholder at the top and leaves the select unselected.
  function fillSelect(selectEl, rows = [], opts = {}) {
    if (!selectEl) return;
    const { textKey = null, valueKey = null, extras = null } = opts;
    selectEl.innerHTML = "";
  
    // 1) placeholder first
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "<select>";
    selectEl.appendChild(ph);
  
    // 2) then options
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
  
    // 3) keep placeholder selected
    selectEl.value = "";
  }

 
  function getMarketplaceSection() {
  // Anchor on any known marketplace control; expand to its nearest section-like container
  const anchor = document.getElementById("marketplaceCategorySelect")
    || document.getElementById("conditionSelect")
    || document.getElementById("brandSelect")
    || document.getElementById("colorSelect");
  if (!anchor) return null;
  return anchor.closest("section, .card, .group, fieldset, .panel, .container, div") || anchor.parentElement;
}
function getBasicSection() {
  const anchor = document.getElementById("categorySelect")
    || document.getElementById("storeLocationSelect")
    || document.getElementById("salesChannelSelect");
  if (!anchor) return null;
  return anchor.closest("section, .card, .group, fieldset, .panel, .container, div") || anchor.parentElement;
}
function setMarketplaceVisibility() {
  const section = getMarketplaceSection();
  if (!section) return;
  section.classList.toggle("hidden", !marketplaceActive());
}

  

  
  // Generic select filler; supports arrays of strings OR objects.
  // Adds a placeholder at the top and leaves the select unselected.
  function fillSelect(selectEl, rows = [], opts = {}) {
    if (!selectEl) return;
    const { textKey = null, valueKey = null, extras = null } = opts;
    selectEl.innerHTML = "";
  
    // 1) placeholder first
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "<select>";
    selectEl.appendChild(ph);
  
    // 2) then options
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
  
    // 3) keep placeholder selected
    selectEl.value = "";
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
  
    const enableAll = () => {
      [lb, oz, len, wid, hei].forEach((el) => { if (el) el.disabled = false; });
    };
    const clearAll = () => {
      [lb, oz, len, wid, hei].forEach((el) => { if (el) el.value = ""; });
    };
  
    const update = () => {
      enableAll();
      const key = sel.value;
      const m = map[key];
      if (!key || !m) { clearAll(); return; } // allow manual entry when no meta
      if (lb) lb.value = m.lb;
      if (oz) oz.value = m.oz;
      if (len) len.value = m.len;
      if (wid) wid.value = m.wid;
      if (hei) hei.value = m.hei;
    };
  
    sel.addEventListener("change", update);
    // Run once on load to ensure fields aren’t left disabled
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
  
  // Helpers needed by computeValidity (top-level so they are always in scope)
  function controlsIn(el) {
    if (!el) return [];
    return Array.from(el.querySelectorAll("input, select, textarea"))
      .filter(n => !n.disabled && n.type !== "hidden");
  }
  function markBatchValidity(nodes, isValidFn) {
    let allOk = true;
    for (const n of nodes) {
      const ok = isValidFn(n);
      n.setAttribute("aria-invalid", ok ? "false" : "true");
      if (!ok) allOk = false;
    }
    return allOk;
  }
  function hasValue(n) {
    if (!n) return false;
    if (n.tagName === "SELECT") return n.value !== "";
    if (n.type === "checkbox" || n.type === "radio") return n.checked;
    return String(n.value ?? "").trim() !== "";
  }
  function setCtasEnabled(isValid) {
    const ids = ["intake-submit", "intake-save", "intake-next", "intake-add-single", "intake-add-bulk"];
    const foundById = ids.map(id => document.getElementById(id)).filter(Boolean);
    const foundByText = Array.from(document.querySelectorAll("button, a[role='button']"))
      .filter(b => /add single item|add to bulk list/i.test((b.textContent || "").trim()));
    [...foundById, ...foundByText].forEach(btn => { btn.disabled = !isValid; });
  }

  function computeValidity() {
    // BASIC card: all fields required, per requirement #4
    const basicSection = getBasicSection();
    const basicControls = controlsIn(basicSection);
    const basicOk = markBatchValidity(basicControls, hasValue);
  
    // MARKETPLACE card: required only when active, per #2/#3
    const marketSection = getMarketplaceSection();
    let marketOk = true;
    if (marketplaceActive()) {
      const marketControls = controlsIn(marketSection);
      marketOk = markBatchValidity(marketControls, hasValue);
    } else {
      controlsIn(marketSection).forEach(n => n.setAttribute("aria-invalid", "false"));
    }
  
    const allOk = basicOk && marketOk;
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
    
    // Toggle marketplace card on load + when channel changes
    setMarketplaceVisibility();
    const salesSel = $("salesChannelSelect");
    if (salesSel) salesSel.addEventListener("change", () => {
      setMarketplaceVisibility();
      computeValidity(); // re-check requireds when channel changes
    });

    // Collect all controls inside a container (inputs, selects, textareas)
    function controlsIn(el) {
      if (!el) return [];
      return Array.from(el.querySelectorAll("input, select, textarea"))
        // exclude deliberately disabled controls
        .filter(n => !n.disabled && n.type !== "hidden");
    }
    
    // Mark invalid/valid for a batch
    function markBatchValidity(nodes, isValidFn) {
      let allOk = true;
      for (const n of nodes) {
        const ok = isValidFn(n);
        n.setAttribute("aria-invalid", ok ? "false" : "true");
        if (!ok) allOk = false;
      }
      return allOk;
    }
    
    // Generic value check for required controls
    function hasValue(n) {
      if (!n) return false;
      if (n.tagName === "SELECT") return n.value !== "";
      if (n.type === "checkbox" || n.type === "radio") return n.checked;
      return String(n.value ?? "").trim() !== "";
    }
    
    // Enable/disable CTAs
    function setCtasEnabled(isValid) {
      // Prefer explicit IDs if you have them
      const ids = ["intake-submit", "intake-save", "intake-next", "intake-add-single", "intake-add-bulk"];
      const foundById = ids.map(id => document.getElementById(id)).filter(Boolean);
      const foundByText = Array.from(document.querySelectorAll("button, a[role='button']"))
        .filter(b => /add single item|add to bulk list/i.test((b.textContent || "").trim()));
    
      [...foundById, ...foundByText].forEach(btn => { btn.disabled = !isValid; });
    }


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
