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
    console.log("[mp] init() starting");
    // Use router-provided session; do NOT re-fetch here
    const session = ctx?.session;
    console.log("[mp] session role:", session?.user?.role || session?.role);

    // Defer authorization to the server (same pattern as Users screen)
    // Fetch available marketplaces + current connection status for this tenant.
    let data;
    try {
      console.log("[mp] window.api type:", typeof window.api);
      data = await window.api("/api/settings/marketplaces/list");
      console.log("[mp] list OK");
    } catch (e) {
      hide(loading);
      if (e && e.status === 403) return show(denied);
      return showBanner("Could not load Marketplace Settings.", "error");
    }

    const rows = data?.marketplaces || [];
    console.log("[mp] rows length:", Array.isArray(rows) ? rows.length : "(not array)");

    const container = document.querySelector("#mp-list");    
    if (!container) {
      hide(loading);
      return showBanner("Marketplace list container not found in HTML.", "error");
    }
    if (!rows.length) {
      container.innerHTML = `
        <div class="card">
          <h3>No marketplaces available</h3>
          <p class="text-muted">We didn’t receive any active rows from <code>app.marketplaces_available</code>. If you expect items, verify <code>is_active = TRUE</code> in the database your Pages env hits.</p>
        </div>`;
    } else {
      container.innerHTML = rows.map((r) => {
      const connected = String(r.status || "").toLowerCase() === "connected";
      const badge = connected ? `<span class="badge" style="margin-left:8px">Connected</span>` : "";
      const btn = connected
        ? `<button class="btn btn--neutral" data-id="${r.id}" disabled>Connected</button>`
        : `<button class="btn btn--primary" data-id="${r.id}">Connect</button>`;
      const notes = r.ui_notes ? `<pre class="text-muted" style="white-space:pre-wrap">${JSON.stringify(r.ui_notes, null, 2)}</pre>` : "";
      return `
        <div class="card">
          <h3 style="display:flex;align-items:center;gap:6px">${r.marketplace_name}${badge}</h3>
          <p class="text-muted">Slug: <code>${r.slug || "-"}</code> · Auth: <code>${r.auth_type}</code></p>
          ${notes}
          <div class="actions">${btn}</div>
        </div>
      ``;
    }).join("");
    }

    // Wire Connect buttons
    container.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        const id = Number(ev.currentTarget.getAttribute("data-id"));
        ev.currentTarget.disabled = true;

        try {
          // Use POST; include id in query as a fallback (helper will attach tenant headers)
          await window.api(`/api/settings/marketplaces/connect?marketplace_id=${id}`, { method: "POST" });
          ev.currentTarget.textContent = "Connected";
          ev.currentTarget.classList.remove("btn--primary");
          ev.currentTarget.classList.add("btn--neutral");
          showBanner("Connection saved.", "info");
        } catch (e) {
          ev.currentTarget.disabled = false;
          if (e && e.status === 403) return showBanner("Access denied.", "error");
          showBanner("Failed to connect. Please try again.", "error");
        }
      });
    });

     hide(loading);
    show(content);
  } catch (err) {
    console.error("[mp] fatal:", err);
    hide(loading);
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
