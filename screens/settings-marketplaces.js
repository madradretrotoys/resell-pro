//begin marketplaces.js
// Settings › Marketplaces (Placeholder)
// Based on screens/_template/screen-template.js: export async function init()

export async function init(ctx) {
  const $ = (sel) => document.querySelector(sel);
  const banner = $("#settings-marketplaces-banner");
  const denied = $("#settings-marketplaces-denied");
  const loading = $("#settings-marketplaces-loading");
  const content = $("#settings-marketplaces-content");

  const show = (el) => { el && (el.hidden = false); };
  const hide = (el) => { el && (el.hidden = true); };

  try { window.ui?.setTitle?.("Marketplace Settings"); } catch {}

  hide(banner);
  hide(denied);
  show(loading);
  hide(content);

  try {
    // Use router-provided session; do NOT re-fetch here
    const session = ctx?.session;

    // Defer authorization to the server (same pattern as Users screen)
    // We call an API endpoint that applies the allowSettings policy.
    try {
      await window.api("/api/settings/marketplaces/list");
    } catch (e) {
      hide(loading);
      if (e && e.status === 403) {
        return show(denied);
      }
      return showBanner("Could not load Marketplace Settings.", "error");
    }
    showBanner("Could not load Marketplace Settings.", "error");
  }

  function showBanner(message, tone = "info") {
    if (!banner) return;
    banner.textContent = message;
    banner.className = `banner ${tone}`;
    banner.hidden = false;
    setTimeout(() => (banner.hidden = true), 5000);
  }
}
//end marketplaces.js
