// Screen Template (Design + Router Contract)
// Contract: router dynamically imports this module and calls the named export `init`.
import { api } from "/assets/js/api.js";

const $ = (id) => document.getElementById(id);

// UX helpers
function setLoading(on) {
  try {
    document.body.classList.toggle("loading", !!on);
  } catch {}
}
function setBanner(msg, kind = "info") {
  const el = $("screen-banner");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("hidden", "banner-info", "banner-success", "banner-error", "banner-warn");
  el.classList.add(`banner-${kind}`);
  if (!msg) el.classList.add("hidden");
}
function showDenied() {
  const denied = $("screen-access-denied");
  if (denied) denied.classList.remove("hidden");
}

// Example data loaders (replace with your real endpoint)
async function loadExampleMeta() {
  // Use your existing lightweight ping or metadata endpoint to assert wiring
  return api("/api/ping", { method: "GET" });
}

// Minimal table render
function renderRows(rows = []) {
  const tbody = $("template-table-body");
  const empty = $("template-empty");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (!rows.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.a ?? ""}</td>
      <td>${r.b ?? ""}</td>
      <td>${r.c ?? ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

// Exported entry point — required by the router
export async function init() {
  setLoading(true);
  setBanner(""); // clear any previous banner

  try {
    // 1) (Router already ensured session.) Sanity ping confirms cookies/tenant headers flow via api()
    await loadExampleMeta();

    // 2) Example: populate select with placeholder (screen-specific logic goes here)
    const exampleSelect = $("exampleSelect");
    if (exampleSelect) {
      exampleSelect.innerHTML = "";
      ["— Select —", "Alpha", "Beta", "Gamma"].forEach((label, i) => {
        const opt = document.createElement("option");
        opt.value = i === 0 ? "" : label.toLowerCase();
        opt.textContent = label;
        exampleSelect.appendChild(opt);
      });
    }

    // 3) Wire basic actions
    const refresh = $("template-refresh");
    if (refresh) refresh.addEventListener("click", () => window.location.reload());

    // 4) Optional: render table sample
    renderRows([
      { a: "Row 1A", b: "Row 1B", c: "Row 1C" },
      { a: "Row 2A", b: "Row 2B", c: "Row 2C" },
    ]);

    // 5) Clear error banner on success
    setBanner("");
  } catch (err) {
    // Auth/permission issues should present as 401/403 from your API helper
    const msg = (err && err.message) || String(err);
    if (/401|403/.test(msg)) {
      showDenied();
    } else {
      setBanner("Something went wrong loading this screen.", "error");
      console.error("template:init error:", err);
    }
  } finally {
    setLoading(false);
  }
}
