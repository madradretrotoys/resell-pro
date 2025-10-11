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

  // Explicitly toggle each Marketplace field container by ID (no wrappers needed)
  const MARKETPLACE_FIELD_IDS = [
    "marketplaceCategorySelect",
    "conditionSelect",
    "brandSelect",
    "colorSelect",
    // Also hide the path display element if present
    "marketplaceCategoryPath",
    "categoryPath"
  ];
  
  function hideShowFieldById(id, hide) {
    const el = document.getElementById(id);
    if (!el) return;
    // Prefer the `.field` wrapper if present; otherwise use the nearest block-level container
    const container =
      el.closest(".field") ||
      el.closest("div, section, fieldset, .group, .card") ||
      el.parentElement;
    if (container) {
      container.classList.toggle("hidden", hide);
    }
  }
  
  // Helper: find a control by its label text (fallback when no ID exists)
function findControlByLabel(labelText) {
  const labels = Array.from(document.querySelectorAll("label"));
  const lbl = labels.find(l => (l.textContent || "").trim().toLowerCase() === labelText.toLowerCase());
  if (!lbl) return null;
  if (lbl.htmlFor) return document.getElementById(lbl.htmlFor) || null;
  // fallback: input/select/textarea right after the label
  let n = lbl.nextElementSibling;
  while (n && !(n instanceof HTMLInputElement || n instanceof HTMLSelectElement || n instanceof HTMLTextAreaElement)) {
    n = n.nextElementSibling;
  }
  return n || null;
}

// Helper: hide/show a field container by its label text
function hideShowFieldByLabel(labelText, hide) {
  const ctl = findControlByLabel(labelText);
  if (!ctl) return;
  const container = ctl.closest(".field") || ctl.closest("div, section, fieldset, .group, .card") || ctl.parentElement;
  if (container) container.classList.toggle("hidden", hide);
}

// Helper: hide/show a section/card by heading text (e.g., "Shipping")
function hideShowSectionByHeading(headingText, hide) {
  const candidates = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,.card-title,.section-title"));
  const h = candidates.find(el => (el.textContent || "").trim().toLowerCase() === headingText.toLowerCase());
  const container = h ? (h.closest(".card") || h.closest("section, .group, fieldset, div")) : null;
  if (container) container.classList.toggle("hidden", hide);
}

// Expanded toggle: include Marketplace Long Description + all Shipping fields + Shipping card
function setMarketplaceVisibility() {
  const hide = !marketplaceActive();

  // Previous ID-based fields
  const MARKETPLACE_FIELD_IDS = [
    "marketplaceCategorySelect", "conditionSelect", "brandSelect", "colorSelect",
    "marketplaceCategoryPath", "categoryPath"
  ];
  MARKETPLACE_FIELD_IDS.forEach((id) => hideShowFieldById(id, hide));

  // Include the new Crosslist to Marketplaces block
  hideShowFieldById("marketplaceCrosslistBlock", hide);

  // Fields that don’t have stable IDs — target by label text:
  hideShowFieldByLabel("Long Description", hide);

  // Shipping group: individual fields + the Shipping section/card
  hideShowFieldById("shippingBoxSelect", hide);
  hideShowFieldByLabel("Weight (lb)", hide);
  hideShowFieldByLabel("Weight (oz)", hide);
  hideShowFieldByLabel("Length", hide);
  hideShowFieldByLabel("Width", hide);
  hideShowFieldByLabel("Height", hide);
  hideShowSectionByHeading("Shipping", hide); // hide the container/card that holds shipping fields
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
    const sel = document.getElementById("shippingBoxSelect");
    if (!sel) return;
  
    // Resolve controls by ID OR label text (robust to markup differences)
    const resolve = (id, labelText) =>
      document.getElementById(id) || findControlByLabel(labelText);
  
    const lb  = resolve("shipWeightLb", "Weight (lb)");
    const oz  = resolve("shipWeightOz", "Weight (oz)");
    const len = resolve("shipLength",   "Length");
    const wid = resolve("shipWidth",    "Width");
    const hei = resolve("shipHeight",   "Height");
  
    const inputs = [lb, oz, len, wid, hei].filter(Boolean);
  
    const map = Object.create(null);
    for (const r of (meta.shipping_boxes || [])) {
      map[r.box_name] = {
        lb: r.weight_lb, oz: r.weight_oz, len: r.length, wid: r.width, hei: r.height,
      };
    }
  
    const enableAll = () => { inputs.forEach((el) => { el.disabled = false; el.readOnly = false; }); };
    const clearAll  = () => { inputs.forEach((el) => { el.value = ""; }); };
  
    const hasMetaValues = (m) => !!m && ![m.lb, m.oz, m.len, m.wid, m.hei].every(v => v == null || v === "");
  
    const update = () => {
      enableAll(); // always allow typing
      const key = sel.value;
      const m = map[key];
  
      // No selection or unknown row => manual
      if (!key || !m) { clearAll(); return; }
  
      // Row exists but empty (e.g., "Custom Box") => manual
      if (!hasMetaValues(m)) { clearAll(); return; }
  
      // Prefill numbers (still editable)
      if (lb)  lb.value  = `${m.lb ?? ""}`;
      if (oz)  oz.value  = `${m.oz ?? ""}`;
      if (len) len.value = `${m.len ?? ""}`;
      if (wid) wid.value = `${m.wid ?? ""}`;
      if (hei) hei.value = `${m.hei ?? ""}`;
    };
  
    sel.addEventListener("change", update);
    update();
  }


  // --- Validation helpers (unchanged) ---
  function getEl(id) { try { return document.getElementById(id); } catch { return null; } }
  function nonEmptySelect(el) { return !!el && el.value !== ""; }
  function markValidity(el, ok) { if (!el) return; el.setAttribute("aria-invalid", ok ? "false" : "true"); }
  function setCtasEnabled(isValid) {
    ["intake-submit", "intake-save", "intake-next", "intake-draft"].forEach((id) => {
      const btn = getEl(id);
      if (btn) btn.disabled = !isValid;
    });
  }

  // === [ADD] resolvers + explicit required-field lists (by ID or label) ===
  function resolveControl(id, labelText) {
    // Prefer ID, fall back to label text (using existing findControlByLabel)
    return (id && document.getElementById(id)) || (labelText && findControlByLabel(labelText)) || null;
  }
  
  // All Basic Item Details are always required.
  // Use ID where we know it; otherwise rely on the visible label text from the HTML screen.
  const BASIC_REQUIRED = [
    { id: null, label: "Item Name / Description" },
    { id: null, label: "Price (USD)" },
    { id: null, label: "Qty" },
    { id: null, label: "Cost of Goods (USD)" },
    { id: "categorySelect", label: "Category" },
    { id: "storeLocationSelect", label: "Store Location" },
    { id: null, label: "Case#/Bin#/Shelf#" },
    { id: "salesChannelSelect", label: "Sales Channel" },
  ];
  
  // Marketplace details are required only when Sales Channel is Both / Marketplace Only.
  const MARKETPLACE_REQUIRED = [
    { id: "marketplaceCategorySelect", label: "Marketplace Category" },
    { id: "conditionSelect",            label: "Condition" },
    { id: "brandSelect",                label: "Brand" },
    { id: "colorSelect",                label: "Primary Color" },
    { id: null,                         label: "Long Description" },
    // Shipping fields are required only when Sales Channel is Both/Marketplace
    { id: "shippingBoxSelect",          label: "Shipping Box" },
    { id: "shipWeightLb",               label: "Weight (lb)" },
    { id: "shipWeightOz",               label: "Weight (oz)" },
    { id: "shipLength",                 label: "Length" },
    { id: "shipWidth",                  label: "Width" },
    { id: "shipHeight",                 label: "Height" },
  ];
  
  function getBasicRequiredControls() {
    return BASIC_REQUIRED
      .map(({ id, label }) => resolveControl(id, label))
      .filter(Boolean)
      .filter(n => !n.disabled && n.type !== "hidden");
  }
  
  function getMarketplaceRequiredControls() {
    return MARKETPLACE_REQUIRED
      .map(({ id, label }) => resolveControl(id, label))
      .filter(Boolean)
      .filter(n => !n.disabled && n.type !== "hidden");
  }
  // === [END ADD] ===
  
  function marketplaceActive() {
    const sales = getEl("salesChannelSelect");
    const v = (sales?.value || "").toLowerCase();
    return v.includes("marketplace") || v.includes("both");
  }

  // === NEW: Marketplace tiles state + helpers ===
  const MP_TILES_ID = "marketplaceTiles";
  const MP_ERROR_ID = "marketplaceTilesError";
  const MP_DEFAULTS_KEY = "rp:intake:lastCrosslist"; // prototype: local defaults

  /** currently selected marketplace IDs (from app.marketplaces_available.id) */
  const selectedMarketplaceIds = new Set();

  function readDefaults() {
    try {
      const raw = localStorage.getItem(MP_DEFAULTS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(Number).filter(n => !Number.isNaN(n)) : [];
    } catch { return []; }
  }
  function writeDefaults(ids) {
    try { localStorage.setItem(MP_DEFAULTS_KEY, JSON.stringify(ids)); } catch {}
  }

  function renderMarketplaceTiles(meta) {
    const host = document.getElementById(MP_TILES_ID);
    if (!host) return;
    host.innerHTML = "";

    const rows = (meta?.marketplaces || []).filter(m => m.is_active !== false);
    const defaults = readDefaults();

    const enableForSelection = (m) => !!(m.enabled_for_tenant && m.is_connected);

    for (const m of rows) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sm rounded-2xl";
      btn.dataset.marketplaceId = String(m.id);
      btn.title = m.marketplace_name || m.slug || "Marketplace";

      const enabledSelectable = enableForSelection(m);

      // baseline visual
      btn.classList.add(enabledSelectable ? "btn-ghost" : "opacity-50", "cursor-not-allowed");
      if (!enabledSelectable) {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
      }

      // label
      btn.textContent = m.marketplace_name || m.slug || `#${m.id}`;

      // preselect from defaults (only if still selectable)
      if (enabledSelectable && defaults.includes(m.id)) {
        selectedMarketplaceIds.add(m.id);
        btn.classList.remove("btn-ghost");
        btn.classList.add("btn-primary");
        btn.setAttribute("aria-pressed", "true");
      } else {
        btn.setAttribute("aria-pressed", "false");
      }

      // click toggles selection if selectable
      if (enabledSelectable) {
        btn.addEventListener("click", () => {
          const id = Number(btn.dataset.marketplaceId);
          const isSel = selectedMarketplaceIds.has(id);
          if (isSel) {
            selectedMarketplaceIds.delete(id);
            btn.classList.remove("btn-primary");
            btn.classList.add("btn-ghost");
            btn.setAttribute("aria-pressed", "false");
          } else {
            selectedMarketplaceIds.add(id);
            btn.classList.remove("btn-ghost");
            btn.classList.add("btn-primary");
            btn.setAttribute("aria-pressed", "true");
          }
          // live-validate after any toggle
          computeValidity();
        });
      } else {
        btn.addEventListener("click", () => {
          alert("This marketplace isn’t connected for your tenant yet. Please ask your manager to connect it.");
        });
      }

      host.appendChild(btn);
    }
  }

  function showMarketplaceTilesError(show) {
    const el = document.getElementById(MP_ERROR_ID);
    if (!el) return;
    el.classList.toggle("hidden", !show);
  }
  // === END NEW ===

  function computeValidity() {
    // BASIC — always required (explicit control list)
    const basicControls = getBasicRequiredControls();
    const basicOk = markBatchValidity(basicControls, hasValue);
  
    // MARKETPLACE — required only when active
    let marketOk = true;
    if (marketplaceActive()) {
      const marketControls = getMarketplaceRequiredControls();
      marketOk = markBatchValidity(marketControls, hasValue);

      // NEW: also require ≥1 marketplace tile selected
      if (marketOk) {
        const hasAny = selectedMarketplaceIds.size >= 1;
        marketOk = marketOk && hasAny;
        showMarketplaceTilesError(!hasAny);
      } else {
        showMarketplaceTilesError(false);
      }
    } else {
      // clear invalid state for marketplace when not required
      getMarketplaceRequiredControls().forEach(n => n.setAttribute("aria-invalid", "false"));
      showMarketplaceTilesError(false);
    }
  
    const allOk = basicOk && marketOk;
    setCtasEnabled(allOk);
    document.dispatchEvent(new CustomEvent("intake:validity-changed", { detail: { valid: allOk } }));
    return allOk;
  }


  
  function hasValue(n) {
    if (!n) return false;
    if (n.tagName === "SELECT") return n.value !== "";
    if (n.type === "checkbox" || n.type === "radio") return n.checked;
    return String(n.value ?? "").trim() !== "";
  }

  function setCtasEnabled(isValid) {
      const ids = ["intake-submit", "intake-save", "intake-next", "intake-add-single", "intake-add-bulk", "intake-draft"];
      const foundById = ids.map(id => document.getElementById(id)).filter(Boolean);
      const foundByText = Array.from(document.querySelectorAll("button, a[role='button']"))
        .filter(b => /add single item|add to bulk list/i.test((b.textContent || "").trim()));
      [...foundById, ...foundByText].forEach(btn => { btn.disabled = !isValid; });
    }

   
  function wireValidation() {
    // Always (re)validate when any required control changes/inputs
    const controls = [
      ...getBasicRequiredControls(),
      ...getMarketplaceRequiredControls(),
    ];
  
    const listen = (el) => {
      if (!el) return;
      const evt = (el.tagName === "SELECT") ? "change" : "input";
      el.addEventListener(evt, computeValidity);
    };
  
    controls.forEach(listen);
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

    // NEW: Render marketplace tiles (below Shipping)
    renderMarketplaceTiles(meta);
    
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

    // [NEW] Default QTY to 1 if empty
    {
      const qty = resolveControl(null, "Qty");
      if (qty && String(qty.value || "").trim() === "") {
        qty.value = "1";
      }
    }

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

    // --- [NEW] Submission wiring: both buttons call POST /api/inventory/intake ---
    function valByIdOrLabel(id, label) {
      const el = id ? document.getElementById(id) : null;
      if (el) return el.value ?? "";
      const byLbl = findControlByLabel(label || "");
      return byLbl ? (byLbl.value ?? "") : "";
    }
    
    function buildPayload() {
      const inventory = {
        product_short_title: valByIdOrLabel(null, "Item Name / Description"),
        price: Number(valByIdOrLabel(null, "Price (USD)") || 0),
        qty: Number(valByIdOrLabel(null, "Qty") || 0),
        cost_of_goods: Number(valByIdOrLabel(null, "Cost of Goods (USD)") || 0),
        category_nm: valByIdOrLabel("categorySelect", "Category"),
        instore_loc: valByIdOrLabel("storeLocationSelect", "Store Location"),
        case_bin_shelf: valByIdOrLabel(null, "Case#/Bin#/Shelf#"),
        instore_online: valByIdOrLabel("salesChannelSelect", "Sales Channel"),
      };
    
      const listing = {
        listing_category: valByIdOrLabel("marketplaceCategorySelect", "Marketplace Category"),
        item_condition: valByIdOrLabel("conditionSelect", "Condition"),
        brand_name: valByIdOrLabel("brandSelect", "Brand"),
        primary_color: valByIdOrLabel("colorSelect", "Primary Color"),
        product_description: valByIdOrLabel(null, "Long Description"),
        shipping_box: valByIdOrLabel("shippingBoxSelect", "Shipping Box"),
        weight_lb: Number(valByIdOrLabel("shipWeightLb", "Weight (lb)") || 0),
        weight_oz: Number(valByIdOrLabel("shipWeightOz", "Weight (oz)") || 0),
        shipbx_length: Number(valByIdOrLabel("shipLength", "Length") || 0),
        shipbx_width: Number(valByIdOrLabel("shipWidth", "Width") || 0),
        shipbx_height: Number(valByIdOrLabel("shipHeight", "Height") || 0),
      };
      // NEW: add selected marketplaces to payload
      const marketplaces_selected = Array.from(selectedMarketplaceIds.values());
      
      return { inventory, listing, marketplaces_selected };
    }
    
    async function submitIntake(mode = "active") {
      // Drafts are allowed to save without full validation; active must validate
      if (mode !== "draft" && !computeValidity()) return;

      const payload = buildPayload();
      if (mode === "draft") {
        payload.status = "draft";
      }
      // If we’re editing an existing item, send its id so the server updates it
      if (__currentItemId) {
        payload.item_id = __currentItemId;
      }

      const res = await api("/api/inventory/intake", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
      if (!res || res.ok === false) {
          throw new Error(res?.error || "intake_failed");
        }

        // Save defaults (local) on success so user gets the same picks next time
        try {
          writeDefaults(Array.from(selectedMarketplaceIds.values()));
        } catch {}

        // Post-save UX: confirm, disable fields, and swap CTAs
        postSaveSuccess(res, mode);
      try {
        const skuEl = document.querySelector("[data-sku-out]");
        if (skuEl && res.sku) skuEl.textContent = res.sku;
      } catch {}
      // Success UX is up to you (toast, clear form, or route back to Inventory)
    }
    
    function wireCtas() {
      const activeIds = ["intake-submit", "intake-save", "intake-add-single", "intake-add-bulk"];
      const draftIds  = ["intake-draft"];

      // Buttons that create ACTIVE items
      const actById = activeIds.map(id => document.getElementById(id)).filter(Boolean);
      const actByText = Array.from(document.querySelectorAll("button, a[role='button']"))
        .filter(b => /add single item|add to bulk list/i.test((b.textContent || "").trim()));
      [...actById, ...actByText].forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            btn.disabled = true;
            await submitIntake("active");
          } catch (err) {
            console.error("intake:submit:error", err);
            alert("Failed to save. Please check required fields and try again.");
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Buttons that save DRAFTS
      const draftButtons = draftIds.map(id => document.getElementById(id)).filter(Boolean);
      draftButtons.forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            btn.disabled = true;
            await submitIntake("draft");
            alert("Draft saved.");
          } catch (err) {
            console.error("intake:draft:error", err);
            alert("Failed to save draft.");
          } finally {
            btn.disabled = false;
          }
        });
      });
    }

    // Remember original actions-row HTML so we can restore the 3 CTAs after editing
    let __originalCtasHTML = null;
    
    // Hold the current item id across edits so the next save updates, not creates
    let __currentItemId = null;

    
    wireCtas();

      // After successful save: confirm, disable form controls, and swap CTAs
      function postSaveSuccess(res, mode) {
        try {
          // 1) Confirmation — show SKU when present, otherwise draft notice
          const skuPart = res?.sku ? `SKU ${res.sku}` : `Draft saved`;
          const msg = mode === "draft"
            ? `Saved draft (#${res?.item_id || "?"}).`
            : `Saved item ${skuPart} (#${res?.item_id || "?"}).`;
          alert(msg);
          // Remember the item id for subsequent edits/saves
          __currentItemId = res?.item_id || __currentItemId;
          // Also stash on the form for resilience (not strictly required)
          try {
            const form = document.getElementById("intakeForm");
            if (form && __currentItemId) form.dataset.itemId = __currentItemId;
          } catch (e) {}
          
        } catch {}
  
        // 2) Disable all form fields (inputs/selects/textareas)
        try {
          const form = document.getElementById("intakeForm");
          if (form) {
            const ctrls = Array.from(form.querySelectorAll("input, select, textarea"));
            ctrls.forEach(el => { el.disabled = true; el.readOnly = true; el.setAttribute("aria-disabled", "true"); });
          }
        } catch {}
  
        // 3) Replace the three CTAs with: Edit Item + Add New Item
        try {
          // Find the first actions row that contains our intake buttons
          const actionsRow = document.querySelector(".actions.flex.gap-2");
          if (actionsRow) {
            const itemId = res?.item_id || "";
        
            // Capture original CTAs the first time we swap them out
            if (__originalCtasHTML == null) {
              __originalCtasHTML = actionsRow.innerHTML;
            }
        
            // Swap to Edit / Add New
            actionsRow.innerHTML = `
              <button id="btnEditItem" class="btn btn-primary btn-sm">Edit Item</button>
              <button id="btnAddNew" class="btn btn-ghost btn-sm">Add New Item</button>
              <button id="btnDeleteItem" class="btn btn-danger btn-sm">Delete</button>
            `;
        
            const btnEdit = document.getElementById("btnEditItem");
            const btnNew  = document.getElementById("btnAddNew");
        
            if (btnEdit) {
              btnEdit.addEventListener("click", (e) => {
                e.preventDefault();
        
               // (1) Re-enable form fields, and lock Category ONLY if a SKU already exists
              try {
                const form = document.getElementById("intakeForm");
                if (form) {
                  const ctrls = Array.from(form.querySelectorAll("input, select, textarea"));
                  ctrls.forEach((el) => {
                    el.disabled = false;
                    el.readOnly = false;
                    el.removeAttribute("aria-disabled");
                  });
              
                  // If the last save returned a SKU, do not allow Category edits
                  const hasSku = !!(res && res.sku);
                  if (hasSku) {
                    const cat = document.getElementById("categorySelect");
                    if (cat) {
                      cat.disabled = true;
                      cat.setAttribute("aria-disabled", "true");
                      const hint = document.getElementById("categoryCodeHint");
                      if (hint) hint.textContent = "Category locked (SKU assigned)";
                    }
                  }
                }
              } catch (err) { /* no-op */ }
        
                // (2) Restore the original 3 CTAs and re-wire their handlers
                try {
                  if (__originalCtasHTML != null) {
                    actionsRow.innerHTML = __originalCtasHTML;
                  }
                  // Reattach events to the restored buttons
                  wireCtas();
                } catch (err) { /* no-op */ }
        
                // (3) Remove success banner (if present) and re-validate to toggle button disabled states
                try {
                  const banner = document.getElementById("intake-save-banner");
                  if (banner) banner.remove();
                } catch (err) { /* no-op */ }
                computeValidity();
        
                // (4) Optional: focus the first field for convenience
                try {
                  const first = document.querySelector("#intakeForm input, #intakeForm select, #intakeForm textarea");
                  if (first) first.focus();
                } catch (err) { /* no-op */ }
              });
            }
        
            if (btnNew) {
              btnNew.addEventListener("click", (e) => {
                e.preventDefault();
                // Reload the intake screen to start a fresh item
                window.location.reload();
              });
            }

            const btnDel = document.getElementById("btnDeleteItem");
            if (btnDel) {
              btnDel.addEventListener("click", async (e) => {
                e.preventDefault();
                try {
                  if (!__currentItemId) return alert("No item to delete.");
                  const sure = confirm("Delete this item? This cannot be undone.");
                  if (!sure) return;
                  btnDel.disabled = true;
                  const resDel = await api("/api/inventory/intake", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "delete", item_id: __currentItemId }),
                  });
                  if (!resDel || resDel.ok === false) {
                    throw new Error(resDel?.error || "delete_failed");
                  }
                  alert("Item deleted.");
                  window.location.reload();
                } catch (err) {
                  console.error("intake:delete:error", err);
                  alert("Failed to delete item.");
                } finally {
                  btnDel.disabled = false;
                }
              });
            }

            
          }
        } catch (err) { /* no-op */ }
      }
  
    
  
  
    
  } catch (err) {
    console.error("Meta load failed:", err);
    const denied = document.getElementById("intake-access-denied");
    if (denied) denied.classList.remove("hidden");
  } finally {
    try { document.body.classList.remove("loading"); } catch {}
  }
}

// end intake js file. 
