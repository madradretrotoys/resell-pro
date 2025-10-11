//begin marketplaces.js
// Settings › Marketplaces (Placeholder)
// Based on screens/_template/screen-template.js: export async function init()
import { api } from '/assets/js/api.js';

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
      data = await api("/api/settings/marketplaces/list");
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
          const enabled   = !!r.enabled;
  
          const notes = r.ui_notes ? `<pre class="text-muted" style="white-space:pre-wrap">${JSON.stringify(r.ui_notes, null, 2)}</pre>` : "";
  
          // Subscribe toggle
          const toggle = `
            <label class="switch" style="display:flex;align-items:center;gap:8px">
              <input type="checkbox" data-action="toggle-enabled" data-id="${r.id}" ${enabled ? "checked" : ""} />
              <span>Enable for tenant</span>
            </label>
          `;
  
          // Connect/Disconnect (only visible if enabled)
          const connectBlock = enabled ? `
            <div class="actions" data-connect-wrap="${r.id}">
              ${
                connected
                ? `<button class="btn btn--neutral" data-action="disconnect" data-id="${r.id}">Disconnect</button>`
                : `<button class="btn btn--primary" data-action="connect" data-id="${r.id}">Connect</button>`
              }
            </div>
          ` : `<div class="actions" data-connect-wrap="${r.id}" hidden></div>`;
  
          // Badges
          const statusBadge = connected ? `<span class="badge" style="margin-left:8px">Connected</span>` : `<span class="badge" style="margin-left:8px">Not connected</span>`;
          const enabledBadge = enabled ? `<span class="badge" style="margin-left:8px">Enabled</span>` : `<span class="badge" style="margin-left:8px">Disabled</span>`;
  
          return `
            <div class="card">
              <h3 style="display:flex;align-items:center;gap:6px">
                ${r.marketplace_name} ${statusBadge} ${enabledBadge}
              </h3>
              <p class="text-muted">Slug: <code>${r.slug || "-"}</code> · Auth: <code>${r.auth_type}</code></p>
              ${notes}
              <div class="row" style="display:flex;align-items:center;gap:12px">${toggle}${connectBlock}</div>
            </div>
          `;
        }).join("");
      }

    // Wire Connect buttons
    // Wire Subscribe toggle
    container.querySelectorAll('input[data-action="toggle-enabled"]').forEach((chk) => {
      chk.addEventListener("change", async (ev) => {
        const el = ev.currentTarget as HTMLInputElement;
        const id = Number(el.getAttribute("data-id"));
        const wrap = container.querySelector(`[data-connect-wrap="${id}"]`) as HTMLElement | null;

        el.disabled = true;
        const wantEnable = el.checked;

        try {
          if (wantEnable) {
            await api("/api/settings/marketplaces/subscribe", { method: "POST", body: { marketplace_id: id } });
            showBanner("Marketplace enabled for tenant.", "info");
            if (wrap) wrap.hidden = false;
          } else {
            await api("/api/settings/marketplaces/unsubscribe", { method: "POST", body: { marketplace_id: id } });
            showBanner("Marketplace disabled for tenant.", "info");
            if (wrap) wrap.hidden = true;
          }
        } catch (e) {
          // revert UI on error
          el.checked = !wantEnable;
          if (e && e.status === 403) return showBanner("Access denied.", "error");
          showBanner("Failed to update subscription.", "error");
        } finally {
          el.disabled = false;
        }
      });
    });

    // Wire Connect / Disconnect buttons
    container.querySelectorAll('button[data-action="connect"]').forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        const b = ev.currentTarget as HTMLButtonElement;
        const id = Number(b.getAttribute("data-id"));
        b.disabled = true;
        try {
          await api(`/api/settings/marketplaces/connect?marketplace_id=${id}`, { method: "POST" });
          b.textContent = "Disconnect";
          b.dataset.action = "disconnect";
          b.classList.remove("btn--primary");
          b.classList.add("btn--neutral");
          showBanner("Connection saved.", "info");
          b.disabled = false;
        } catch (e) {
          b.disabled = false;
          if (e && e.status === 403) return showBanner("Access denied.", "error");
          showBanner("Failed to connect. Please try again.", "error");
        }
      });
    });
    container.querySelectorAll('button[data-action="disconnect"]').forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        const b = ev.currentTarget as HTMLButtonElement;
        const id = Number(b.getAttribute("data-id"));
        b.disabled = true;
        try {
          await api(`/api/settings/marketplaces/disconnect?marketplace_id=${id}`, { method: "POST" });
          b.textContent = "Connect";
          b.dataset.action = "connect";
          b.classList.remove("btn--neutral");
          b.classList.add("btn--primary");
          showBanner("Disconnected.", "info");
          b.disabled = false;
        } catch (e) {
          b.disabled = false;
          if (e && e.status === 403) return showBanner("Access denied.", "error");
          showBanner("Failed to disconnect.", "error");
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
