// Settings Landing (Chooser)
// Based on screens/_template/screen-template.js contract: export async function init()
// Uses existing auth/api/ui helpers if present; falls back gracefully.

export async function init() {
  const $ = (sel) => document.querySelector(sel);
  const show = (el) => { el && (el.hidden = false); };
  const hide = (el) => { el && (el.hidden = true); };
  const banner = $("#settings-landing-banner");
  const denied = $("#settings-landing-denied");
  const loading = $("#settings-landing-loading");
  const content = $("#settings-landing-content");

  // Helper to set page title if your UI helper exists
  try { window.ui?.setTitle?.("Settings"); } catch {}

  hide(banner);
  hide(denied);
  show(loading);
  hide(content);

  try {
    // Ensure session (project protocol)
    let session = null;
    if (window.auth?.ensureSession) {
      session = await window.auth.ensureSession();
    } else if (window.api) {
      // Fallback: hit session endpoint directly if needed
      const res = await window.api("/api/auth/session");
      session = res?.data || res;
    }

    const role = session?.user?.role || session?.role || "";
    const isOwnerOrAdmin = ["owner", "Owner", "admin", "Admin"].includes(role);

    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");

    // Backward-compatible deep-links:
    if (tab === "users") {
      return routeToUsers();
    }
    if (tab === "marketplaces") {
      return routeToMarketplaces();
    }

    // If not privileged, send them straight to Users
    if (!isOwnerOrAdmin) {
      return routeToUsers();
    }

    // Privileged: render chooser
    hide(loading);
    show(content);

    // Wire actions
    $("#goto-user-settings")?.addEventListener("click", routeToUsers);
    $("#goto-user-settings")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") routeToUsers();
    });

    $("#goto-marketplace-settings")?.addEventListener("click", routeToMarketplaces);
    $("#goto-marketplace-settings")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") routeToMarketplaces();
    });

  } catch (err) {
    console.error(err);
    hide(loading);
    if (err?.status === 403) {
      show(denied);
      return;
    }
    showBanner("Unable to load Settings. Please try again.", "error");
  }

  function showBanner(message, tone = "info") {
    if (!banner) return;
    banner.textContent = message;
    banner.className = `banner ${tone}`;
    banner.hidden = false;
    setTimeout(() => (banner.hidden = true), 5000);
  }

  function routeToUsers() {
    window.router?.go?.("?page=settings&tab=users") || (window.location.href = "?page=settings&tab=users");
  }

  function routeToMarketplaces() {
    window.router?.go?.("?page=settings&tab=marketplaces") || (window.location.href = "?page=settings&tab=marketplaces");
  }
}
