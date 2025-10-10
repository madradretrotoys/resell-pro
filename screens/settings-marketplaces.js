// Settings › Marketplaces (Placeholder)
// Based on screens/_template/screen-template.js: export async function init()

export async function init() {
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
    // Auth + role (project protocol)
    let session = null;
    if (window.auth?.ensureSession) {
      session = await window.auth.ensureSession();
    } else if (window.api) {
      const res = await window.api("/api/auth/session");
      session = res?.data || res;
    }

    const role = session?.user?.role || session?.role || "";
    const isOwnerOrAdmin = ["owner", "Owner", "admin", "Admin"].includes(role);

    if (!isOwnerOrAdmin) {
      hide(loading);
      return show(denied);
    }

    // Placeholder render
    hide(loading);
    show(content);

  } catch (err) {
    console.error(err);
    hide(loading);
    if (err?.status === 403) {
      return show(denied);
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
