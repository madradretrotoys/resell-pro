async function init() {
  await ensure();
  disableWrites();

  // Lightweight loading state on <body> to prevent flicker.
  try { document.body.classList.add('loading'); } catch {}

  // Helper: ensure a select shows a placeholder if it ended up empty
  function ensurePlaceholder(selectEl, placeholderText = "— Select —") {
    if (!selectEl) return;
    const hasOptions = selectEl.options && selectEl.options.length > 0;
    if (hasOptions) return;
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholderText;
    selectEl.appendChild(opt);
    // Keep it selected to hint the user
    selectEl.value = "";
  }

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
  } catch (err) {
    console.error("Meta load failed:", err);
    const denied = $("intake-access-denied");
    if (denied) denied.classList.remove("hidden");
  } finally {
    try { document.body.classList.remove('loading'); } catch {}
  }
}
