
// assets/js/timesheet.js
(() => {
  // Mirrors the old behavior: token required, load profile, load today + pay period
  // Old code used localStorage('mrad_token') and 'apiVerify' before calling timesheet APIs. :contentReference[oaicite:5]{index=5}
  const token = localStorage.getItem("mrad_token");
  if (!token) {
    // Adjust this to your router/login pattern if different
    window.location.href = "/?page=login";
    return;
  }

  let _logs = [];
  let profile = null;
  let todayRow = null;

  const busyEl = document.getElementById("rpBusy");
  const setBusy = (on) => {
    if (!busyEl) return;
    busyEl.setAttribute("aria-hidden", on ? "false" : "true");
    busyEl.setAttribute("aria-busy", on ? "true" : "false");
  };

  const log = (msg) => {
    const ts = new Date().toLocaleTimeString();
    _logs.push(`[${ts}] ${msg}`);
    console.log(msg);
    const el = document.getElementById("logs");
    if (el) el.textContent = _logs.join("\n");
  };

  const apiFetch = async (path, { method = "GET", body } = {}) => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 401) {
        localStorage.removeItem("mrad_token");
        localStorage.removeItem("mrad_profile");
        window.location.href = "/?page=login";
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      return data;
    } finally {
      setBusy(false);
    }
  };

  const showError = (err) => {
    const msg = (err && err.message) ? err.message : String(err);
    log("ERROR: " + msg);
    alert("Error: " + msg);
  };

  const loadProfile = async () => {
    // If you already cache profile elsewhere, keep it — this matches your old flow. :contentReference[oaicite:6]{index=6}
    const p = await apiFetch("/api/auth/session", { method: "GET" });
    profile = p?.profile || p; // allow either shape
    try { localStorage.setItem("mrad_profile", JSON.stringify(profile)); } catch (_) {}
    return profile;
  };

  const loadToday = async () => {
    const row = await apiFetch("/api/time/today", { method: "GET" });
    renderToday(row);
  };

  const loadPeriod = async () => {
    const rows = await apiFetch("/api/time/list-my", { method: "GET" });
    renderPeriod(rows);
  };

  const punch = async (type, btn) => {
    try {
      if (btn) { btn.disabled = true; btn.dataset._label = btn.textContent; btn.textContent = "Working…"; }
      log("Punching " + type);
      const row = await apiFetch("/api/time/punch", { method: "POST", body: { type } });
      todayRow = row;
      renderToday(row);
      await loadPeriod();
    } catch (e) {
      showError(e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset._label || btn.textContent; }
    }
  };

  const showEditToday = () => {
    const card = document.getElementById("editTodayCard");
    if (card) card.style.display = "block";
  };

  const cancelEditToday = () => {
    const card = document.getElementById("editTodayCard");
    if (card) card.style.display = "none";
    renderToday(todayRow);
  };

  const saveEditToday = async (btn) => {
    try {
      if (!todayRow) return;

      const payload = {
        dateKey: todayRow.date,
        login: (profile && profile.login_id) || (profile && profile.login) || "",
        fields: {
          clockIn:  document.getElementById("tiClockIn").value.trim(),
          lunchOut: document.getElementById("tiLunchOut").value.trim(),
          lunchIn:  document.getElementById("tiLunchIn").value.trim(),
          clockOut: document.getElementById("tiClockOut").value.trim(),
        },
        note: (document.getElementById("tiNote").value || "").trim(),
      };

      const re = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/;
      for (const [k, v] of Object.entries(payload.fields)) {
        if (v && !re.test(v)) {
          alert(`Invalid ${k} time. Use HH:MM AM/PM, e.g., 9:05 AM`);
          return;
        }
      }

      if (btn) { btn.disabled = true; btn.dataset._label = btn.textContent; btn.textContent = "Working…"; }
      log("Saving edit today: " + JSON.stringify(payload.fields));
      const row = await apiFetch("/api/time/edit", { method: "POST", body: payload });
      todayRow = row;
      renderToday(row);
      await loadPeriod();
    } catch (e) {
      showError(e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset._label || btn.textContent; }
    }
  };

  const mgrSave = async (btn) => {
    try {
      const payload = {
        dateKey: (document.getElementById("mgrDate").value || "").trim(),
        login: (document.getElementById("mgrLogin").value || "").trim(),
        fields: {
          clockIn:  (document.getElementById("mgrIn").value || "").trim(),
          lunchOut: (document.getElementById("mgrLout").value || "").trim(),
          lunchIn:  (document.getElementById("mgrLin").value || "").trim(),
          clockOut: (document.getElementById("mgrOut").value || "").trim(),
        },
        note: (document.getElementById("mgrNote").value || "").trim(),
      };

      if (!payload.dateKey || !payload.login) {
        alert("Login ID and Date are required.");
        return;
      }

      const re = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/;
      for (const [k, v] of Object.entries(payload.fields)) {
        if (v && !re.test(v)) {
          alert(`Invalid ${k} time. Use HH:MM AM/PM, e.g., 9:05 AM`);
          return;
        }
      }

      if (btn) { btn.disabled = true; btn.dataset._label = btn.textContent; btn.textContent = "Working…"; }
      log("Manager save: " + JSON.stringify({ login: payload.login, dateKey: payload.dateKey, fields: payload.fields }));
      await apiFetch("/api/time/edit", { method: "POST", body: payload });
      await loadToday();
      await loadPeriod();
    } catch (e) {
      showError(e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset._label || btn.textContent; }
    }
  };

  const renderToday = (row) => {
    if (!row) {
      log("Loaded today: null");
      document.getElementById("today").textContent = "No record for today.";
      return;
    }
    todayRow = row;
    log("Loaded today: " + JSON.stringify(row));

    const el = document.getElementById("today");
    el.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <h3>Today: ${row.date}</h3>
        <span class="pill muted">Role:
          <strong style="margin-left:6px; font-weight:600">${(profile && (profile.role || profile.role_name)) || "Clerk"}</strong>
        </span>
      </div>
      <div class="status ${row.status ? String(row.status).toLowerCase() : ""}">Status: ${row.status || "Open"}</div>
      <div class="card" style="margin-top:10px">
        <div class="row">
          <div>Clock In: <strong>${row.clockIn || ""}</strong></div>
          <div>Lunch Out: <strong>${row.lunchOut || ""}</strong></div>
          <div>Lunch In: <strong>${row.lunchIn || ""}</strong></div>
          <div>Clock Out: <strong>${row.clockOut || ""}</strong></div>
          <div>Total Hours: <strong>${row.totalHours || ""}</strong></div>
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-success" id="btnClockIn">Clock In</button>
        <button class="btn btn-warning" id="btnLunchOut">Lunch Out</button>
        <button class="btn btn-info"    id="btnLunchIn">Lunch In</button>
        <button class="btn btn-danger"  id="btnClockOut">Clock Out</button>
        <button class="btn btn-ghost"   id="btnEditToday">Edit Today</button>
      </div>

      <div id="editTodayCard" class="card" style="display:none">
        <div class="row"><strong>Edit Today (HH:MM AM/PM)</strong>
          <span class="muted">Employees: same-day only. Managers can edit any date/user (panel below).</span>
        </div>
        <div class="row">
          <label>Clock In <input id="tiClockIn" type="text" placeholder="e.g. 9:05 AM" value="${row.clockIn || ""}"></label>
          <label>Lunch Out <input id="tiLunchOut" type="text" placeholder="e.g. 12:00 PM" value="${row.lunchOut || ""}"></label>
          <label>Lunch In <input id="tiLunchIn" type="text" placeholder="e.g. 12:30 PM" value="${row.lunchIn || ""}"></label>
          <label>Clock Out <input id="tiClockOut" type="text" placeholder="e.g. 5:45 PM" value="${row.clockOut || ""}"></label>
        </div>
        <div class="row" style="margin-top:6px;">
          <input id="tiNote" type="text" placeholder="Optional note for this correction…" style="flex:1;">
        </div>
        <div class="row">
          <button class="btn btn-primary" id="btnSaveEditToday">Save</button>
          <button class="btn btn-ghost"   id="btnCancelEditToday">Cancel</button>
        </div>
      </div>
    `;

    // Wire buttons with anti-double-click UX
    document.getElementById("btnClockIn").onclick   = (e) => punch("CLOCK_IN", e.currentTarget);
    document.getElementById("btnLunchOut").onclick  = (e) => punch("LUNCH_OUT", e.currentTarget);
    document.getElementById("btnLunchIn").onclick   = (e) => punch("LUNCH_IN", e.currentTarget);
    document.getElementById("btnClockOut").onclick  = (e) => punch("CLOCK_OUT", e.currentTarget);
    document.getElementById("btnEditToday").onclick = () => showEditToday();
    document.getElementById("btnCancelEditToday").onclick = () => cancelEditToday();
    document.getElementById("btnSaveEditToday").onclick = (e) => saveEditToday(e.currentTarget);

    // Manager panel visibility (same as old HTML) :contentReference[oaicite:7]{index=7}
    const isMgr = profile && ((profile.role || profile.role_name) === "Admin" || (profile.role || profile.role_name) === "Manager");
    const mgr = document.getElementById("mgrBox");
    if (mgr) mgr.style.display = isMgr ? "block" : "none";
  };

  const renderPeriod = (rows) => {
    rows = Array.isArray(rows) ? rows : [];
    log("Loaded period rows (" + rows.length + ")");
    const table = document.getElementById("periodTable");
    table.innerHTML = `
      <tr><th>Date</th><th>Clock In</th><th>Lunch Out</th><th>Lunch In</th><th>Clock Out</th><th>Total Hours</th><th>Status</th></tr>
      ${rows.map(r => `
        <tr>
          <td>${r.date}</td>
          <td>${r.clockIn || ""}</td>
          <td>${r.lunchOut || ""}</td>
          <td>${r.lunchIn || ""}</td>
          <td>${r.clockOut || ""}</td>
          <td>${r.totalHours || ""}</td>
          <td>${r.status || ""}</td>
        </tr>
      `).join("")}
    `;
  };

  const wireManagerButton = () => {
    const btn = document.getElementById("btnMgrSave");
    if (btn) btn.onclick = (e) => mgrSave(e.currentTarget);
  };

  const boot = async () => {
    try {
      log("Timesheet page loading…");
      await loadProfile();
      wireManagerButton();
      await loadToday();
      await loadPeriod();
    } catch (e) {
      showError(e);
    }
  };

  window.addEventListener("load", boot);
})();
