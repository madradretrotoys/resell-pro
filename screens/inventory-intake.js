// /screens/inventory-intake.js

(function () {
  async function ensure() {
    try {
      if (typeof ensureSession === "function") {
        await ensureSession(); // verifies login per project protocol
      }
    } catch (err) {
      console.error("ensureSession error:", err);
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function option(text, value, extra = {}) {
    const o = document.createElement("option");
    o.textContent = text;
    o.value = value ?? text;
    Object.entries(extra).forEach(([k, v]) => (o.dataset[k] = v));
    return o;
  }

  function fillSelect(selectEl, values, { textKey = null, valueKey = null, extras = null } = {}) {
    selectEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    values.forEach((v) => {
      const text = textKey ? v[textKey] : v;
      const val = valueKey ? v[valueKey] : v;
      const ex  = extras ? extras(v) : {};
      frag.appendChild(option(text, val, ex));
    });
    selectEl.appendChild(frag);
  }

  function disableWrites() {
    const ids = ["btnAddSingle", "btnAddBulk", "copyTitleBtn", "copySkuBtn", "copySkuLocationBtn", "copyPriceBtn", "copyXeasyBtn", "copyBusinessDetailsBtn"];
    ids.forEach((id) => {
      const el = $(id);
      if (el) el.disabled = true;
    });
  }

  async function loadMeta() {
    // Use centralized api() helper; it automatically attaches tenant/session (per protocol)
    const res = await api("/api/inventory/meta", { method: "GET" });
    return res;
  }

  function wireShippingBoxAutofill(meta) {
    const sel = $("shippingBoxSelect");
    const wlb = $("weightLbInput");
    const woz = $("weightOzInput");
    const len = $("lengthInput");
    const wid = $("widthInput");
    const hei = $("heightInput");

    function setFromName(name) {
      const box = meta.shipping_boxes.find((b) => b.box_name === name);
      if (!box) return;
      wlb.value = box.weight_lb ?? "";
      woz.value = box.weight_oz ?? "";
      len.value = box.length ?? "";
      wid.value = box.width ?? "";
      hei.value = box.height ?? "";
    }

    sel.addEventListener("change", (e) => setFromName(e.target.value));
    if (sel.value) setFromName(sel.value);
  }

  function wireMarketplaceCategoryPath() {
    const sel = $("marketplaceCategorySelect");
    const pathEl = $("marketplaceCategoryPath");
    function updatePath() {
      const opt = sel.options[sel.selectedIndex];
      pathEl.textContent = opt?.dataset?.path || "—";
    }
    sel.addEventListener("change", updatePath);
    updatePath();
  }

  function wireCategoryCodeHint(meta) {
    const sel = $("categorySelect");
    const hint = $("categoryCodeHint");
    function updateHint() {
      const opt = sel.options[sel.selectedIndex];
      const code = opt?.dataset?.code || "";
      hint.textContent = code ? `SKU Prefix: ${code}` : "";
    }
    sel.addEventListener("change", updateHint);
    updateHint();
  }

  async function init() {
    await ensure();
    disableWrites();

    // Defensive: show a friendly access message if server returns 403
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

    } catch (err) {
      console.error("Meta load failed:", err);
      const denied = $("intake-access-denied");
      if (denied) denied.classList.remove("hidden");
    }
  }

  // Expose a named init in case your router calls it explicitly
  window.InventoryIntake = { init };

  // Also auto-init if the screen HTML is already present
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("inventory-intake-screen");
    if (el) init();
  });
})();
