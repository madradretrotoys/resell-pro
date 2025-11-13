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
  
    // NEW: environment selector wiring
    try {
      const currentEnv = (window.localStorage.getItem('mp_env') || 'sandbox').toLowerCase();
      const radios = document.querySelectorAll('input[name="mp-env"]');
      radios.forEach(r => {
        r.checked = r.value === currentEnv;
        r.addEventListener('change', (ev) => {
          const val = ev.currentTarget.value;
          window.localStorage.setItem('mp_env', val);
          console.log('[mp] env set to', val);
          // optional: quick confirmation
          const banner = document.getElementById('settings-marketplaces-banner');
          if (banner) {
            banner.textContent = `eBay environment set to ${val}.`;
            banner.className = 'banner info';
            banner.hidden = false;
            setTimeout(() => (banner.hidden = true), 3000);
          }
        });
      });
    } catch {}
  
    try {
      // Use router-provided session; do NOT re-fetch here
      console.log("[mp] init() starting");
    
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
  
          // Subscribe toggle (accessible switch)
          const toggle = `
            <label class="switch">
              <input type="checkbox" role="switch" aria-checked="${enabled}" data-action="toggle-enabled" data-id="${r.id}" ${enabled ? "checked" : ""} />
              <span class="slider" aria-hidden="true"></span>
              <span class="switch-label">Enable for tenant</span>
            </label>
          `;
          
          // Connect/Disconnect (always render the block; hide only when disabled)
          const connectBtn = connected
            ? `<button class="btn btn--neutral" data-action="disconnect" data-id="${r.id}">Disconnect</button>`
            : `<button class="btn btn--primary" data-action="connect" data-id="${r.id}">Connect</button>`;
          
          const connectBlock = `
            <div class="actions" data-connect-wrap="${r.id}" ${enabled ? "" : "hidden"}>
              ${connectBtn}
            </div>
          `;
  
          // Badges
          const statusBadge = connected ? `Connected` : `Not connected`;
          const enabledBadge = enabled ? `Enabled` : `Disabled`;
          
          // If server reports an error status, surface a small Retry control
          const needsAttention = String(r.status || "").toLowerCase() === "error";
          const retryBlock = needsAttention
            ? `
          <button class="btn btn--warning btn--sm" data-action="retry" data-id="${r.marketplace_id}">Retry</button>
          `
            : "";
          
          return `
            <div class="mp-row">
              <div class="mp-left">
                <div class="mp-name">${r.marketplace_name}</div>
                ${toggle}
              </div>
          
              <div class="mp-right" data-connect-wrap="${r.id}" ${enabled ? "" : "hidden"}>
                ${connectBtn}
                ${retryBlock}
              </div>
            </div>
          `;
        }).join("");
      }

    // Wire Connect buttons
    // Wire Subscribe toggle
    container.querySelectorAll('input[data-action="toggle-enabled"]').forEach((chk) => {
      chk.addEventListener("change", async (ev) => {
        const el = ev.currentTarget; // HTMLInputElement
        const id = Number(el.getAttribute("data-id"));
        const wrap = container.querySelector(`[data-connect-wrap="${id}"]`);
        
        el.disabled = true;
        const wantEnable = el.checked;
        
        try {
          if (wantEnable) {
            await api("/api/settings/marketplaces/subscribe", { method: "POST", body: { marketplace_id: id } });
            el.setAttribute("aria-checked", "true");
            if (wrap) wrap.hidden = false;  // wrapper already contains the button
            showBanner("Marketplace enabled for tenant.", "info");
          } else {
            await api("/api/settings/marketplaces/unsubscribe", { method: "POST", body: { marketplace_id: id } });
            el.setAttribute("aria-checked", "false");
            if (wrap) wrap.hidden = true;
            showBanner("Marketplace disabled for tenant.", "info");
          }
        } catch (e) {
          // revert UI on error
          el.checked = !wantEnable;
          el.setAttribute("aria-checked", String(!wantEnable));
          if (e && e.status === 403) return showBanner("Access denied.", "error");
          showBanner("Failed to update subscription.", "error");
        } finally {
          el.disabled = false;
        }

      });
    });

    // Wire Connect / Disconnect buttons
    // CONNECT
    container.querySelectorAll('button[data-action="connect"]').forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        const b = ev.currentTarget;
        const id = Number(b.getAttribute("data-id"));
        b.disabled = true;
        try {
          // Start OAuth and follow the returned eBay consent URL
          const environment = window.localStorage.getItem('mp_env') || 'sandbox';
          const { redirect_url } = await api('/api/settings/marketplaces/ebay/start', {
            method: 'POST',
            body: { marketplace_id: id, environment }
          });
          window.location.href = redirect_url;
          return; // leave the page for eBay; on return the list will refresh & show status
        } catch (e) {
          if (e && e.status === 403) showBanner("Access denied.", "error");
          else showBanner("Failed to start eBay connect. Please try again.", "error");
        } finally {
          b.disabled = false;
        }
      });
    });
    
    // DISCONNECT
    container.querySelectorAll('button[data-action="disconnect"]').forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        const b = ev.currentTarget;
        const id = Number(b.getAttribute("data-id"));
        b.disabled = true;
        try {
          await api(`/api/settings/marketplaces/disconnect?marketplace_id=${id}`, { method: "POST" });
          b.textContent = "Connect";
          b.dataset.action = "connect";
          b.classList.remove("btn--neutral");
          b.classList.add("btn--primary");
          showBanner("Disconnected.", "info");
        } catch (e) {
          if (e && e.status === 403) showBanner("Access denied.", "error");
          else showBanner("Failed to disconnect.", "error");
        } finally {
          b.disabled = false;
        }
      });
    });

      // RETRY
      container.querySelectorAll('button[data-action="retry"]').forEach((btn) => {
        btn.addEventListener("click", async (ev) => {
          const b = ev.currentTarget;
          const id = Number(b.getAttribute("data-id"));
          b.disabled = true;
          try {
            await api('/api/settings/marketplaces/ebay/refresh', { method: 'POST', body: { marketplace_id: id } });
            showBanner("Retry successful. Updating status…", "info");
            // Keep it simple for v1: reload to re-run init() and pull fresh statuses
            window.location.reload();
          } catch (e) {
            if (e && e.status === 403) showBanner("Access denied.", "error");
            else showBanner("Retry failed. Please reconnect.", "error");
          } finally {
            b.disabled = false;
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
