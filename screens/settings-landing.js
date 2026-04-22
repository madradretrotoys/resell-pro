// Begin landing.js Settings Landing (Chooser)
export async function init(ctx) {
  const $ = (sel) => document.querySelector(sel);
  const show = (el) => { el && (el.hidden = false); };
  const hide = (el) => { el && (el.hidden = true); };

  const banner  = $("#settings-landing-banner");
  const denied  = $("#settings-landing-denied");
  const loading = $("#settings-landing-loading");
  const content = $("#settings-landing-content");

  try { window.ui?.setTitle?.("Settings"); } catch {}

  hide(banner);
  hide(denied);
  show(loading);
  hide(content);

  try {
    // ✅ Use router-provided session (do NOT re-fetch)
    const session = ctx?.session;
    const roleRaw = session?.user?.role ?? session?.role ?? "";
    const rl = roleRaw?.toLowerCase?.();
    const knowsRole = Boolean(rl);
    const isOwnerOrAdmin = rl === "owner" || rl === "admin";
    // Only redirect when we POSITIVELY know user is NOT owner/admin
    if (knowsRole && !isOwnerOrAdmin) {
      return routeToUsers();
    }

    // Privileged (or role unknown): render chooser and wire actions
    hide(loading);
    show(content);

    $("#goto-user-settings")?.addEventListener("click", routeToUsers);
    $("#goto-user-settings")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") routeToUsers();
    });

    $("#goto-marketplace-settings")?.addEventListener("click", routeToMarketplaces);
    $("#goto-marketplace-settings")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") routeToMarketplaces();
    });

    $("#goto-business-hours-settings")?.addEventListener("click", routeToBusinessHours);
    $("#goto-business-hours-settings")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") routeToBusinessHours();
    });

    $("#goto-drawer-settings")?.addEventListener("click", routeToDrawers);
    $("#goto-drawer-settings")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") routeToDrawers();
    });

    $("#goto-employee-schedules-settings")?.addEventListener("click", routeToEmployeeSchedules);
    $("#goto-employee-schedules-settings")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") routeToEmployeeSchedules();
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
    // Your router uses '?page=<key>' keys (see router.js)
    window.router?.go?.("?page=settings-users") || (window.location.href = "?page=settings-users");
  }

  function routeToMarketplaces() {
    window.router?.go?.("?page=settings-marketplaces") || (window.location.href = "?page=settings-marketplaces");
  }

  function routeToBusinessHours() {
    window.router?.go?.("?page=settings-business-hours") || (window.location.href = "?page=settings-business-hours");
  }

  function routeToDrawers() {
    window.router?.go?.("?page=settings-drawers") || (window.location.href = "?page=settings-drawers");
  }

  function routeToEmployeeSchedules() {
    window.router?.go?.("?page=settings-employee-schedules") || (window.location.href = "?page=settings-employee-schedules");
  }
}
// end landing.js 
