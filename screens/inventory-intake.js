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
