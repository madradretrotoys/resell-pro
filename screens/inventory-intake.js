import { api } from "/assets/js/api.js";

// Exported so router can call it: router awaits `mod.init(...)` after importing this module.
// (See assets/js/router.js for the dynamic import and named-export call.)
export async function init() {
  // Lightweight loading flag
  try { document.body.classList.add("loading"); } catch {}

  // ——— Local helpers (screen-scoped) ———
  const $ = (id) => document.getElementById(id);

  // ====== Photos state & helpers (NEW) ======
  const MAX_PHOTOS = 15;
  let __photos = [];              // [{image_id, cdn_url, is_primary, sort_order, r2_key, width, height, bytes, content_type}]
  let __pendingFiles = [];        // Files awaiting upload (before item_id exists)
  let __currentItemId = null;     // sync with existing flow
  let __reorderMode = false;
  
  // Utility: update counter + disable add when maxed
  function updatePhotosUIBasic() {
    const count = __photos.length + __pendingFiles.length;
    const cap = `${count} / ${MAX_PHOTOS}`;
    const el = $("photosCount");
    if (el) el.textContent = cap;
  
    const canAdd = count < MAX_PHOTOS;
    const cam = $("photoCameraInput");
    const fil = $("photoFileInput");
    if (cam) cam.disabled = !canAdd;
    if (fil) fil.disabled = !canAdd;
  }
  
  // Render thumbnails
  function renderPhotosGrid() {
    const host = $("photosGrid");
    if (!host) return;
    // safety: fixed-size columns
    // safety: fixed-size columns + consistent row height
    try {
      host.style.gridTemplateColumns = "repeat(auto-fill, 140px)";
      host.style.gridAutoRows = "140px";
      host.style.alignItems = "start";
      host.style.justifyItems = "start";
    } catch {}
    host.innerHTML = "";
  
    // Existing images (from DB)
    for (const img of __photos.sort((a,b)=>a.sort_order-b.sort_order)) {
      host.appendChild(renderThumb(img, { persisted: true }));
    }
  
    // Pending files (preview only)
    for (const f of __pendingFiles) {
      host.appendChild(renderThumb({ cdn_url: URL.createObjectURL(f), is_primary: false }, { pending: true }));
    }
  
    updatePhotosUIBasic();
  }
  
  // Thumb element
  function renderThumb(model, flags) {
  const { persisted = false, pending = false } = flags || {};
  const wrap = document.createElement("div");
  // fixed 140x140 thumb box (pure CSS styles; no Tailwind utilities)
  wrap.className = "relative group border rounded-xl overflow-hidden";
  wrap.style.width = "140px";
  wrap.style.height = "140px";
  wrap.style.display = "inline-block"; // ensure the grid cell stays compact
  wrap.tabIndex = 0;

  const img = new Image();
  img.src = model.cdn_url || "";
  img.alt = "Item photo";
  img.loading = "lazy";
  img.className = "block";
  img.style.width = "140px";
  img.style.height = "140px";
  img.style.objectFit = "cover";
  img.style.display = "block";
  wrap.appendChild(img);

  const bar = document.createElement("div");
  bar.className = "absolute inset-x-0 bottom-0 p-1 bg-black/50 opacity-0 group-hover:opacity-100 transition";
  bar.innerHTML = `
    <div class="flex gap-1 justify-center">
      <button class="btn btn-ghost btn-sm" data-act="crop" title="Crop">Crop</button>
      <label class="btn btn-ghost btn-sm cursor-pointer" title="Replace">
        Replace
        <input type="file" accept="image/*" class="hidden" data-act="replace">
      </label>
      <button class="btn btn-ghost btn-sm" data-act="primary" ${pending ? "disabled" : ""} title="Set Primary">Primary</button>
      <button class="btn btn-ghost btn-sm" data-act="delete" title="Delete">Delete</button>
    </div>
  `;
    wrap.appendChild(bar);
  
    // Drag handle in reorder mode
    if (__reorderMode && persisted) {
      wrap.draggable = true;
      wrap.dataset.imageId = model.image_id;
      wrap.classList.add("cursor-move");
      wrap.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", model.image_id);
      });
      hostDragEnable();
    }
  
    // Wire actions
    bar.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const act = btn.dataset.act;
    
      if (act === "crop") {
        await openCropper(model, { pending });
      } else if (act === "primary" && persisted) {
        await setPrimary(model.image_id);
      } else if (act === "delete") {
        if (pending) {
          // remove from pending preview
          const i = __pendingFiles.findIndex(f => model.cdn_url && model.cdn_url.startsWith("blob:"));
          if (i >= 0) __pendingFiles.splice(i, 1);
          renderPhotosGrid();
        } else if (persisted) {
          await deleteImage(model.image_id);
        }
      }
    });
    // Replace (separate input)
    bar.querySelector('input[type="file"][data-act="replace"]')?.addEventListener("change", async (ev) => {
      const f = ev.target.files?.[0];
      if (!f) return;
      await replaceImage(model, f);
    });
  
    return wrap;
  }
  
  // Enable drop targets to reorder cards
  function hostDragEnable() {
    const host = $("photosGrid");
    if (!host) return;
    host.addEventListener("dragover", (e) => { if (__reorderMode) e.preventDefault(); });
    host.addEventListener("drop", async (e) => {
      if (!__reorderMode) return;
      e.preventDefault();
      const draggingId = e.dataTransfer.getData("text/plain");
      const target = e.target.closest("[data-image-id]");
      const targetId = target?.dataset.imageId;
      if (!draggingId || !targetId || draggingId === targetId) return;
  
      // compute new order: move dragging before target
      const order = __photos.slice().sort((a,b)=>a.sort_order-b.sort_order);
      const fromIdx = order.findIndex(r => r.image_id === draggingId);
      const toIdx   = order.findIndex(r => r.image_id === targetId);
      if (fromIdx < 0 || toIdx < 0) return;
  
      const [moved] = order.splice(fromIdx, 1);
      order.splice(toIdx, 0, moved);
      order.forEach((r, i) => r.sort_order = i);
  
      // persist
      try {
        await api("/api/images/reorder", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            item_id: __currentItemId,
            orders: order.map(r => ({ image_id: r.image_id, sort_order: r.sort_order }))
          })
        });
        __photos = order;
        renderPhotosGrid();
      } catch { alert("Failed to reorder."); }
    }, { once: true });
  }
  
  // Simple browser-side resize/compress to keep uploads fast
  async function downscaleToBlob(file, maxEdge = 2048, quality = 0.9) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
  
    const cnv = document.createElement("canvas");
    cnv.width = w; cnv.height = h;
    const ctx = cnv.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const type = /image\/(png|webp)/i.test(file.type) ? file.type : "image/jpeg";
    const blob = await new Promise(res => cnv.toBlob(res, type, quality));
    return new File([blob], file.name.replace(/\.(heic|heif)$/i, ".jpg"), { type });
  }
  
  // Upload + attach (requires item_id)
  async function uploadAndAttach(file, { cropOfImageId = null } = {}) {
    if (!__currentItemId) {
      __pendingFiles.push(file);
      renderPhotosGrid();
      return;
    }
    const body = new FormData();
    body.append("file", file);
    const up = await api(`/api/images/upload?item_id=${encodeURIComponent(__currentItemId)}&filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body
    });
    if (!up || up.ok === false) throw new Error(up?.error || "upload_failed");
  
    const at = await api("/api/images/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        item_id: __currentItemId,
        ...up
      })
    });
    if (!at || at.ok === false) throw new Error(at?.error || "attach_failed");
  
    // If this was a crop-replace, consider deleting the original
    if (cropOfImageId) {
      try { await deleteImage(cropOfImageId, { silent: true }); } catch {}
    }
  
    // Refresh in-memory list
    __photos.push({
      image_id: at.image_id,
      cdn_url: up.cdn_url,
      is_primary: at.is_primary,
      sort_order: (__photos.length),
      r2_key: up.r2_key,
      width: up.width, height: up.height, bytes: up.bytes, content_type: up.content_type,
    });
    renderPhotosGrid();
  }
  
  // Set primary
  async function setPrimary(image_id) {
    if (!__currentItemId) return alert("Save the item first.");
    const res = await api("/api/images/set-primary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: __currentItemId, image_id })
    });
    if (!res || res.ok === false) return alert(res?.error || "Failed to set primary.");
    __photos.forEach(p => p.is_primary = (p.image_id === image_id));
    renderPhotosGrid();
  }
  
  // Delete
  async function deleteImage(image_id, { silent = false } = {}) {
    if (!__currentItemId) return;
    const res = await api("/api/images/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: __currentItemId, image_id })
    });
    if (!res || res.ok === false) { if (!silent) alert(res?.error || "Failed to delete."); return; }
    __photos = __photos.filter(p => p.image_id !== image_id);
    renderPhotosGrid();
  }
  
  // Replace
  async function replaceImage(oldModel, newFile) {
    const ds = await downscaleToBlob(newFile);
    await uploadAndAttach(ds, { cropOfImageId: oldModel.image_id });
  }
  
  // Minimal cropper: square crop with zoom+drag
  let __cropState = { img: null, zoom: 1, dx: 0, dy: 0, baseW: 0, baseH: 0, targetId: null };
  async function openCropper(model, { pending = false } = {}) {
    // load source
    const src = model.cdn_url;
    const img = await (async () => {
      const i = new Image();
      i.crossOrigin = "anonymous";
      i.src = src;
      await new Promise((r, j) => { i.onload = r; i.onerror = j; });
      return i;
    })();
  
    __cropState.img = img;
    __cropState.zoom = 1;
    __cropState.dx = 0;
    __cropState.dy = 0;
    __cropState.targetId = model.image_id || null;
  
    const dlg  = $("cropDialog");
    const cnv  = $("cropCanvas");
    const zoom = $("cropZoom");
    const ctx  = cnv.getContext("2d");
  
    function redraw() {
      const Z = Number(zoom.value || 1);
      __cropState.zoom = Z;
      ctx.clearRect(0, 0, cnv.width, cnv.height);
      // cover-fit draw
      const baseScale = Math.max(cnv.width / img.width, cnv.height / img.height);
      const s = baseScale * Z;
      const drawW = img.width * s;
      const drawH = img.height * s;
      const x = (cnv.width - drawW) / 2 + __cropState.dx;
      const y = (cnv.height - drawH) / 2 + __cropState.dy;
      ctx.drawImage(img, x, y, drawW, drawH);
    }
  
    let dragging = false, lastX = 0, lastY = 0;
    cnv.onmousedown  = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
    cnv.onmouseup    = ()  => { dragging = false; };
    cnv.onmouseleave = ()  => { dragging = false; };
    cnv.onmousemove  = (e) => {
      if (!dragging) return;
      __cropState.dx += (e.clientX - lastX);
      __cropState.dy += (e.clientY - lastY);
      lastX = e.clientX; lastY = e.clientY;
      redraw();
    };
    zoom.oninput = redraw;
  
    dlg.showModal();
    redraw();
  
    $("cropCancelBtn").onclick = () => dlg.close();
  
    $("cropSaveBtn").onclick = async () => {
      cnv.toBlob(async (blob) => {
        if (!blob) return;
        const f = new File([blob], "crop.jpg", { type: "image/jpeg" });
  
        if (pending) {
          // Pending image (no image_id yet):
          // 1) If we already have an item_id, upload now and remove one pending preview.
          // 2) If we don't yet have an item_id, replace one pending slot with the cropped file.
          if (__currentItemId) {
            try {
              await uploadAndAttach(f);
              // best-effort: remove one pending placeholder to avoid duplicates
              if (Array.isArray(__pendingFiles) && __pendingFiles.length) {
                __pendingFiles.splice(0, 1);
              }
              renderPhotosGrid();
            } catch (e) {
              alert("Failed to upload cropped image.");
            }
          } else {
            // Replace one pending entry locally
            if (Array.isArray(__pendingFiles) && __pendingFiles.length) {
              __pendingFiles.splice(0, 1, f);
            } else {
              __pendingFiles.push(f);
            }
            renderPhotosGrid();
          }
        } else {
          // Persisted image: upload the cropped version and delete the original server-side
          await uploadAndAttach(f, { cropOfImageId: __cropState.targetId });
        }
  
        dlg.close();
      }, "image/jpeg", 0.92);
    };
  }

  
  // Wire inputs
  function wirePhotoPickers() {
    // Camera modal open
    $("openCameraBtn")?.addEventListener("click", async ()=>{
      const dlg = $("cameraDialog");
      const video = $("cameraVideo");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).catch(()=>null);
      if (!stream) { alert("Camera not available. Use Upload Photo."); return; }
      video.srcObject = stream;
      dlg.showModal();
  
      const stop = ()=>{ try { stream.getTracks().forEach(t=>t.stop()); } catch {} };
  
      $("cameraCancelBtn").onclick = ()=>{ stop(); dlg.close(); };
      $("cameraSnapBtn").onclick   = async ()=>{
        const canvas = $("cameraCanvas");
        const ctx = canvas.getContext("2d");
        // draw current frame
        const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
        canvas.width = vw; canvas.height = vh;
        ctx.drawImage(video, 0, 0, vw, vh);
        canvas.toBlob(async (blob)=>{
          if (!blob) return;
          stop();
          dlg.close();
          const file = new File([blob], `camera_${Date.now()}.jpg`, { type: "image/jpeg" });
          const ds = await downscaleToBlob(file);
          await uploadAndAttach(ds);
        }, "image/jpeg", 0.92);
      };
    });
  
    // Fallback “camera” input (kept hidden)
    $("photoCameraInput")?.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        if (__photos.length + __pendingFiles.length >= MAX_PHOTOS) break;
        const ds = await downscaleToBlob(f);
        await uploadAndAttach(ds);
      }
      e.target.value = "";
    });
  
    // Upload from gallery/files
    $("photoFileInput")?.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        if (__photos.length + __pendingFiles.length >= MAX_PHOTOS) break;
        const ds = await downscaleToBlob(f);
        await uploadAndAttach(ds);
      }
      e.target.value = "";
    });
  
    $("photoReorderToggle")?.addEventListener("click", ()=>{
      __reorderMode = !__reorderMode;
      renderPhotosGrid();
      alert(__reorderMode ? "Reorder ON: drag photos to rearrange." : "Reorder OFF");
    });
  
      document.addEventListener("intake:item-saved", async (ev) => {
      try {
        const id = ev?.detail?.item_id;
        if (!id) return;
        __currentItemId = id;
    
        if (__pendingFiles.length === 0) return;
        const pending = __pendingFiles.splice(0, __pendingFiles.length);
        for (const f of pending) {
          await uploadAndAttach(f);
        }
      } catch (e) {
        console.error("photos:flush:error", e);
      }
    });
  }




  
  async function loadMeta() {
    const res = await api("/api/inventory/meta", { method: "GET" });
    if (!res || res.ok === false) throw new Error(res?.error || "meta_failed");
    return res;
  }

  // Generic select filler; supports arrays of strings OR objects.
  // Adds a placeholder at the top and leaves the select unselected.
  function fillSelect(selectEl, rows = [], opts = {}) {
    if (!selectEl) return;
    const { textKey = null, valueKey = null, extras = null } = opts;
    selectEl.innerHTML = "";
  
    // 1) placeholder first
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "<select>";
    selectEl.appendChild(ph);
  
    // 2) then options
    for (const row of rows || []) {
      const opt = document.createElement("option");
      const text = textKey ? row?.[textKey] : String(row ?? "");
      const value = valueKey ? row?.[valueKey] : String(row ?? "");
      opt.textContent = text ?? "";
      opt.value = value ?? "";
      if (extras && typeof extras === "function") {
        const ex = extras(row) || {};
        for (const k in ex) opt.dataset[k] = ex[k];
      }
      selectEl.appendChild(opt);
    }
  
    // 3) keep placeholder selected
    selectEl.value = "";
  }

 
  function getMarketplaceSection() {
    // Anchor on any known marketplace control; expand to its nearest section-like container
    const anchor = document.getElementById("marketplaceCategorySelect")
      || document.getElementById("conditionSelect")
      || document.getElementById("brandSelect")
      || document.getElementById("colorSelect");
    if (!anchor) return null;
    return anchor.closest("section, .card, .group, fieldset, .panel, .container, div") || anchor.parentElement;
  }
  function getBasicSection() {
    const anchor = document.getElementById("categorySelect")
      || document.getElementById("storeLocationSelect")
      || document.getElementById("salesChannelSelect");
    if (!anchor) return null;
    return anchor.closest("section, .card, .group, fieldset, .panel, .container, div") || anchor.parentElement;
  }

  // Explicitly toggle each Marketplace field container by ID (no wrappers needed)
  const MARKETPLACE_FIELD_IDS = [
    "marketplaceCategorySelect",
    "conditionSelect",
    "brandSelect",
    "colorSelect",
    // Also hide the path display element if present
    "marketplaceCategoryPath",
    "categoryPath"
  ];
  
  function hideShowFieldById(id, hide) {
    const el = document.getElementById(id);
    if (!el) return;
    // Prefer the `.field` wrapper if present; otherwise use the nearest block-level container
    const container =
      el.closest(".field") ||
      el.closest("div, section, fieldset, .group, .card") ||
      el.parentElement;
    if (container) {
      container.classList.toggle("hidden", hide);
    }
  }
  
  // Helper: find a control by its label text (fallback when no ID exists)
function findControlByLabel(labelText) {
  const labels = Array.from(document.querySelectorAll("label"));
  const lbl = labels.find(l => (l.textContent || "").trim().toLowerCase() === labelText.toLowerCase());
  if (!lbl) return null;
  if (lbl.htmlFor) return document.getElementById(lbl.htmlFor) || null;
  // fallback: input/select/textarea right after the label
  let n = lbl.nextElementSibling;
  while (n && !(n instanceof HTMLInputElement || n instanceof HTMLSelectElement || n instanceof HTMLTextAreaElement)) {
    n = n.nextElementSibling;
  }
  return n || null;
}

// Helper: hide/show a field container by its label text
function hideShowFieldByLabel(labelText, hide) {
  const ctl = findControlByLabel(labelText);
  if (!ctl) return;
  const container = ctl.closest(".field") || ctl.closest("div, section, fieldset, .group, .card") || ctl.parentElement;
  if (container) container.classList.toggle("hidden", hide);
}

// Helper: hide/show a section/card by heading text (e.g., "Shipping")
function hideShowSectionByHeading(headingText, hide) {
  const candidates = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,.card-title,.section-title"));
  const h = candidates.find(el => (el.textContent || "").trim().toLowerCase() === headingText.toLowerCase());
  const container = h ? (h.closest(".card") || h.closest("section, .group, fieldset, div")) : null;
  if (container) container.classList.toggle("hidden", hide);
}

// Expanded toggle: include Marketplace Long Description + all Shipping fields + Shipping card
function setMarketplaceVisibility() {
  const hide = !marketplaceActive();

  // Previous ID-based fields
  const MARKETPLACE_FIELD_IDS = [
    "marketplaceCategorySelect", "conditionSelect", "brandSelect", "colorSelect",
    "marketplaceCategoryPath", "categoryPath"
  ];
  MARKETPLACE_FIELD_IDS.forEach((id) => hideShowFieldById(id, hide));

  // Include the new Crosslist to Marketplaces block
  hideShowFieldById("marketplaceCrosslistBlock", hide);

  // Fields that don’t have stable IDs — target by label text:
  hideShowFieldByLabel("Long Description", hide);

  // Shipping group: individual fields + the Shipping section/card
  hideShowFieldById("shippingBoxSelect", hide);
  hideShowFieldByLabel("Weight (lb)", hide);
  hideShowFieldByLabel("Weight (oz)", hide);
  hideShowFieldByLabel("Length", hide);
  hideShowFieldByLabel("Width", hide);
  hideShowFieldByLabel("Height", hide);
  hideShowSectionByHeading("Shipping", hide); // hide the container/card that holds shipping fields
}

  

  
  function ensurePlaceholder(selectEl, placeholderText = "— Select —") {
    if (!selectEl) return;
    const hasOptions = selectEl.options && selectEl.options.length > 0;
    if (hasOptions) return;
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholderText;
    selectEl.appendChild(opt);
    selectEl.value = "";
  }

  // Small no-op wires (safe if elements aren’t present)
  function wireCategoryCodeHint(meta) {
    const sel = $("categorySelect");
    const hint = $("categoryCodeHint");
    if (!sel || !hint) return;
    const update = () => {
      const opt = sel.options[sel.selectedIndex];
      const code = opt?.dataset?.code || "";
      hint.textContent = code ? `Code: ${code}` : "";
    };
    sel.addEventListener("change", update);
    update();
  }

  function wireMarketplaceCategoryPath() {
    const sel = $("marketplaceCategorySelect");
    const pathEl =
      $("marketplaceCategoryPath") ||
      document.querySelector("[data-category-path]") ||
      document.getElementById("categoryPath");
    if (!sel || !pathEl) return;
    const update = () => {
      const opt = sel.options[sel.selectedIndex];
      const path = opt?.dataset?.path || "—";
      pathEl.textContent = path;
    };
    sel.addEventListener("change", update);
    update();
  }

  function wireShippingBoxAutofill(meta) {
    const sel = document.getElementById("shippingBoxSelect");
    if (!sel) return;
  
    // Resolve controls by ID OR label text (robust to markup differences)
    const resolve = (id, labelText) =>
      document.getElementById(id) || findControlByLabel(labelText);
  
    const lb  = resolve("shipWeightLb", "Weight (lb)");
    const oz  = resolve("shipWeightOz", "Weight (oz)");
    const len = resolve("shipLength",   "Length");
    const wid = resolve("shipWidth",    "Width");
    const hei = resolve("shipHeight",   "Height");
  
    const inputs = [lb, oz, len, wid, hei].filter(Boolean);
  
    const map = Object.create(null);
    for (const r of (meta.shipping_boxes || [])) {
      map[r.box_name] = {
        lb: r.weight_lb, oz: r.weight_oz, len: r.length, wid: r.width, hei: r.height,
      };
    }
  
    const enableAll = () => { inputs.forEach((el) => { el.disabled = false; el.readOnly = false; }); };
    const clearAll  = () => { inputs.forEach((el) => { el.value = ""; }); };
  
    const hasMetaValues = (m) => !!m && ![m.lb, m.oz, m.len, m.wid, m.hei].every(v => v == null || v === "");
  
    const update = () => {
      enableAll(); // always allow typing
      const key = sel.value;
      const m = map[key];
  
      // No selection or unknown row => manual
      if (!key || !m) { clearAll(); return; }
  
      // Row exists but empty (e.g., "Custom Box") => manual
      if (!hasMetaValues(m)) { clearAll(); return; }
  
      // Prefill numbers (still editable)
      if (lb)  lb.value  = `${m.lb ?? ""}`;
      if (oz)  oz.value  = `${m.oz ?? ""}`;
      if (len) len.value = `${m.len ?? ""}`;
      if (wid) wid.value = `${m.wid ?? ""}`;
      if (hei) hei.value = `${m.hei ?? ""}`;
    };
  
    sel.addEventListener("change", update);
    update();
  }


 
    // --- Validation helpers (HOISTED so computeValidity can see them) ---
  function getEl(id) { try { return document.getElementById(id); } catch { return null; } }
  function markValidity(el, ok) { if (!el) return; el.setAttribute("aria-invalid", ok ? "false" : "true"); }

  // Generic value check for required controls
  function hasValue(n) {
    if (!n) return false;
    if (n.tagName === "SELECT") return n.value !== "";
    if (n.type === "checkbox" || n.type === "radio") return n.checked;
    return String(n.value ?? "").trim() !== "";
  }

  // Mark invalid/valid for a batch
  function markBatchValidity(nodes, isValidFn) {
    let allOk = true;
    for (const n of nodes) {
      const ok = isValidFn(n);
      n.setAttribute("aria-invalid", ok ? "false" : "true");
      if (!ok) allOk = false;
    }
    return allOk;
  }

  // Enable/disable CTAs:
  // - ACTIVE CTAs (Add Single / Add to Bulk) depend on full validity
  // - DRAFT CTA depends only on the Title being non-empty
  function setCtasEnabled(activeValid) {
    // ACTIVE CTAs (Add Single / Add to Bulk) by id or visible text:
    const activeIds = ["intake-submit", "intake-save", "intake-next", "intake-add-single", "intake-add-bulk", "btnAddSingle_bottom", "btnAddBulk_bottom"];
    const actById   = activeIds.map((id) => document.getElementById(id)).filter(Boolean);
    const actByText = Array.from(document.querySelectorAll("button, a[role='button']"))
      .filter((b) => /add single item|add to bulk list/i.test((b.textContent || "").trim()));
  
    [...actById, ...actByText].forEach((btn) => {
      const enable = !!activeValid;
      btn.disabled = !enable;
      btn.classList.toggle("opacity-60", !enable);
      btn.classList.toggle("cursor-not-allowed", !enable);
    });
  
    // DRAFT CTA: enable if Title has any value OR at least one photo (pending or persisted)
    const title = resolveControl(null, "Item Name / Description");
    const hasTitle = !!title && String(title.value || "").trim() !== "";
    const photoCount = (__photos?.length || 0) + (__pendingFiles?.length || 0);
    const hasAnyPhoto = photoCount >= 1;
    const draftOk = hasTitle || hasAnyPhoto;
    const draftBtn = document.getElementById("intake-draft");
    if (draftBtn) {
      draftBtn.disabled = !draftOk;
      draftBtn.classList.toggle("opacity-60", !draftOk);
      draftBtn.classList.toggle("cursor-not-allowed", !draftOk);
    }
  }


  // === [ADD] resolvers + explicit required-field lists (by ID or label) ===
  function resolveControl(id, labelText) {
    // Prefer ID, fall back to label text (using existing findControlByLabel)
    return (id && document.getElementById(id)) || (labelText && findControlByLabel(labelText)) || null;
  }
  
  // All Basic Item Details are always required.
  // Use ID where we know it; otherwise rely on the visible label text from the HTML screen.
  const BASIC_REQUIRED = [
    { id: null, label: "Item Name / Description" },
    { id: null, label: "Price (USD)" },
    { id: null, label: "Qty" },
    { id: null, label: "Cost of Goods (USD)" },
    { id: "categorySelect", label: "Category" },
    { id: "storeLocationSelect", label: "Store Location" },
    { id: null, label: "Case#/Bin#/Shelf#" },
    { id: "salesChannelSelect", label: "Sales Channel" },
  ];
  
  // Marketplace details are required only when Sales Channel is Both / Marketplace Only.
  const MARKETPLACE_REQUIRED = [
    { id: "marketplaceCategorySelect", label: "Marketplace Category" },
    { id: "conditionSelect",            label: "Condition" },
    { id: "brandSelect",                label: "Brand" },
    { id: "colorSelect",                label: "Primary Color" },
    { id: null,                         label: "Long Description" },
    // Shipping fields are required only when Sales Channel is Both/Marketplace
    { id: "shippingBoxSelect",          label: "Shipping Box" },
    { id: "shipWeightLb",               label: "Weight (lb)" },
    { id: "shipWeightOz",               label: "Weight (oz)" },
    { id: "shipLength",                 label: "Length" },
    { id: "shipWidth",                  label: "Width" },
    { id: "shipHeight",                 label: "Height" },
  ];
  
  function getBasicRequiredControls() {
    return BASIC_REQUIRED
      .map(({ id, label }) => resolveControl(id, label))
      .filter(Boolean)
      .filter(n => !n.disabled && n.type !== "hidden");
  }
  
  function getMarketplaceRequiredControls() {
    return MARKETPLACE_REQUIRED
      .map(({ id, label }) => resolveControl(id, label))
      .filter(Boolean)
      .filter(n => !n.disabled && n.type !== "hidden");
  }
  // === [END ADD] ===
  
  function marketplaceActive() {
    const sales = getEl("salesChannelSelect");
    const v = (sales?.value || "").toLowerCase();
    return v.includes("marketplace") || v.includes("both");
  }

  // === NEW: Marketplace tiles state + helpers ===
  const MP_TILES_ID = "marketplaceTiles";
  const MP_ERROR_ID = "marketplaceTilesError";
  const MP_DEFAULTS_KEY = "rp:intake:lastCrosslist"; // prototype: local defaults

  /** currently selected marketplace IDs (from app.marketplaces_available.id) */
  const selectedMarketplaceIds = new Set();

  function readDefaults() {
    try {
      const raw = localStorage.getItem(MP_DEFAULTS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(Number).filter(n => !Number.isNaN(n)) : [];
    } catch { return []; }
  }
  function writeDefaults(ids) {
    try { localStorage.setItem(MP_DEFAULTS_KEY, JSON.stringify(ids)); } catch {}
  }

  function renderMarketplaceTiles(meta) {
    const host = document.getElementById(MP_TILES_ID);
    if (!host) return;
    host.innerHTML = "";

    const rows = (meta?.marketplaces || []).filter(m => m.is_active !== false);
    const defaults = readDefaults();

    // PROTOTYPE RULE:
    // If ZERO marketplaces are connected for this tenant, allow selecting ALL active marketplaces.
    const anyConnected = rows.some(r => r.enabled_for_tenant && r.is_connected);
    const enableForSelection = (m) => {
      if (anyConnected) {
        return !!(m.enabled_for_tenant && m.is_connected);
      }
      // Prototype fallback: let the user pick active marketplaces even without connections
      return m.is_active !== false;
    };
    
    for (const m of rows) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sm rounded-2xl";
      btn.dataset.marketplaceId = String(m.id);
      btn.title = m.marketplace_name || m.slug || "Marketplace";

      const enabledSelectable = enableForSelection(m);

      // Baseline styling
      btn.className = "btn btn-sm rounded-2xl";

      

      if (enabledSelectable) {
        // Enabled tiles start as ghost (pale) until selected
        btn.classList.add("btn-ghost");
      } else {
        // Disabled tiles are dimmed and non-interactive
        btn.classList.add("btn-ghost", "opacity-50", "cursor-not-allowed");
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
      }

      // label
      btn.textContent = m.marketplace_name || m.slug || `#${m.id}`;

      // preselect from defaults (only if still selectable)
      if (enabledSelectable && defaults.includes(m.id)) {
        selectedMarketplaceIds.add(m.id);
        btn.classList.remove("btn-ghost");
        btn.classList.add("btn-primary");
        btn.setAttribute("aria-pressed", "true");
      } else {
        btn.setAttribute("aria-pressed", "false");
      }

      // click toggles selection if selectable
      if (enabledSelectable) {
        btn.addEventListener("click", () => {
          const id = Number(btn.dataset.marketplaceId);
          const isSel = selectedMarketplaceIds.has(id);
          if (isSel) {
            selectedMarketplaceIds.delete(id);
            btn.classList.remove("btn-primary");
            btn.classList.add("btn-ghost");
            btn.setAttribute("aria-pressed", "false");
          } else {
            selectedMarketplaceIds.add(id);
            btn.classList.remove("btn-ghost");
            btn.classList.add("btn-primary");
            btn.setAttribute("aria-pressed", "true");
          }
          // live-validate after any toggle
          computeValidity();
        });
      } else {
        btn.addEventListener("click", () => {
          alert("This marketplace isn’t connected for your tenant yet. Please ask your manager to connect it.");
        });
      }

      host.appendChild(btn);
    }
  }

  function showMarketplaceTilesError(show) {
    const el = document.getElementById(MP_ERROR_ID);
    if (!el) return;
    el.classList.toggle("hidden", !show);
  }
  // === END NEW ===

  function computeValidity() {
    // BASIC — always required (explicit control list)
    const basicControls = getBasicRequiredControls();
    const basicOk = markBatchValidity(basicControls, hasValue);
  
    // MARKETPLACE — required only when active
    let marketOk = true;
    if (marketplaceActive()) {
      const marketControls = getMarketplaceRequiredControls();
      marketOk = markBatchValidity(marketControls, hasValue);

      // NEW: also require ≥1 marketplace tile selected
      if (marketOk) {
        const hasAny = selectedMarketplaceIds.size >= 1;
        marketOk = marketOk && hasAny;
        showMarketplaceTilesError(!hasAny);
      } else {
        showMarketplaceTilesError(false);
      }
    } else {
      // clear invalid state for marketplace when not required
      getMarketplaceRequiredControls().forEach(n => n.setAttribute("aria-invalid", "false"));
      showMarketplaceTilesError(false);
    }
  
    const allOk = basicOk && marketOk;
    setCtasEnabled(allOk);
    document.dispatchEvent(new CustomEvent("intake:validity-changed", { detail: { valid: allOk } }));
    return allOk;
  }

// --- Drafts refresh bus + helpers (anchored insert) ---
let __draftsRefreshTimer = null;

function isDraftsTabVisible() {
  const tab = document.querySelector('[data-tab="drafts"], #tabDrafts, #draftsTab');
  const host = tab || document.getElementById("recentDraftsTbody")?.closest("section,div,table");
  if (!host) return true; // if we can't detect, allow refresh
  const hiddenByAttr = host.getAttribute("hidden") != null;
  const hiddenByClass = host.classList.contains("hidden");
  return !(hiddenByAttr || hiddenByClass);
}

async function refreshDrafts({ force = false } = {}) {
  if (!force && !isDraftsTabVisible()) return;
  if (__draftsRefreshTimer) window.clearTimeout(__draftsRefreshTimer);
  __draftsRefreshTimer = window.setTimeout(async () => {
    try {
      const header = document.querySelector('#recentDraftsHeader, [data-recent-drafts-header]');
      if (header) header.classList.add("loading");
      // Support scope where loadDrafts is defined later/inside try{}
      const __callLoadDrafts = (window && window.__loadDrafts) || (typeof loadDrafts === "function" ? loadDrafts : null);
      if (__callLoadDrafts) { await __callLoadDrafts(); }
    } finally {
      const header = document.querySelector('#recentDraftsHeader, [data-recent-drafts-header]');
      if (header) header.classList.remove("loading");
      __draftsRefreshTimer = null;
    }
  }, 300);
}

// Central event to refresh Drafts after successful add/save/delete
document.addEventListener("intake:item-changed", () => refreshDrafts({ force: true }));
// --- end Drafts refresh bus ---


  
  
  
  function wireValidation() {
    // Always (re)validate when any required control changes/inputs
    const controls = [
      ...getBasicRequiredControls(),
      ...getMarketplaceRequiredControls(),
    ];
  
    const listen = (el) => {
      if (!el) return;
      const evt = (el.tagName === "SELECT") ? "change" : "input";
      el.addEventListener(evt, computeValidity);
    };
  
    controls.forEach(listen);
  }
  
  // --- end validation helpers ---

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

    // NEW: Render marketplace tiles (below Shipping)
    renderMarketplaceTiles(meta);
    
    // Store + channel
    fillSelect($("storeLocationSelect"), meta.store_locations);
    fillSelect($("salesChannelSelect"), meta.sales_channels);
    
    // Toggle marketplace card on load + when channel changes
    setMarketplaceVisibility();
    const salesSel = $("salesChannelSelect");
    if (salesSel) salesSel.addEventListener("change", () => {
      setMarketplaceVisibility();
      computeValidity(); // re-check requireds when channel changes
    });

    // [NEW] Default QTY to 1 if empty
    {
      const qty = resolveControl(null, "Qty");
      if (qty && String(qty.value || "").trim() === "") {
        qty.value = "1";
      }
    }

    // Collect all controls inside a container (inputs, selects, textareas)
    function controlsIn(el) {
      if (!el) return [];
      return Array.from(el.querySelectorAll("input, select, textarea"))
        // exclude deliberately disabled controls
        .filter(n => !n.disabled && n.type !== "hidden");
    }
    

    // Apply placeholders if any list was empty
    ensurePlaceholder($("categorySelect"));
    ensurePlaceholder($("marketplaceCategorySelect"));
    ensurePlaceholder($("brandSelect"));
    ensurePlaceholder($("conditionSelect"));
    ensurePlaceholder($("colorSelect"));
    ensurePlaceholder($("shippingBoxSelect"));
    ensurePlaceholder($("storeLocationSelect"));
    ensurePlaceholder($("salesChannelSelect"));

    // Wire and run initial validation
    wireValidation();
    computeValidity();
    
    // Auto-load drafts into the Drafts tab on screen load (does not auto-switch the tab)
    await loadDrafts?.();
    
    // --- [NEW] Submission wiring: both buttons call POST /api/inventory/intake ---
    function valByIdOrLabel(id, label) {
      const el = id ? document.getElementById(id) : null;
      if (el) return el.value ?? "";
      const byLbl = findControlByLabel(label || "");
      return byLbl ? (byLbl.value ?? "") : "";
    }
    
    function buildPayload(isDraft = false) {
      // helper: drop empty strings/null/undefined
      const prune = (obj) => {
        const out = {};
        for (const [k, v] of Object.entries(obj || {})) {
          if (v === null || v === undefined) continue;
          if (typeof v === "string" && v.trim() === "") continue;
          out[k] = v;
        }
        return out;
      };
    
      const title = valByIdOrLabel(null, "Item Name / Description");
    
      // Collect all possible fields (strings left as entered; numbers coerced when present)
      const invAll = {
        product_short_title: title,
        price: (() => { const v = valByIdOrLabel(null, "Price (USD)"); return v !== "" ? Number(v) : undefined; })(),
        qty: (() => { const v = valByIdOrLabel(null, "Qty"); return v !== "" ? Number(v) : undefined; })(),
        cost_of_goods: (() => { const v = valByIdOrLabel(null, "Cost of Goods (USD)"); return v !== "" ? Number(v) : undefined; })(),
        category_nm: valByIdOrLabel("categorySelect", "Category"),
        instore_loc: valByIdOrLabel("storeLocationSelect", "Store Location"),
        case_bin_shelf: valByIdOrLabel(null, "Case#/Bin#/Shelf#"),
        instore_online: valByIdOrLabel("salesChannelSelect", "Sales Channel"),
      };
    
      const listingAll = {
        listing_category: valByIdOrLabel("marketplaceCategorySelect", "Marketplace Category"),
        item_condition:   valByIdOrLabel("conditionSelect", "Condition"),
        brand_name:       valByIdOrLabel("brandSelect", "Brand"),
        primary_color:    valByIdOrLabel("colorSelect", "Primary Color"),
        product_description: valByIdOrLabel(null, "Long Description"),
        shipping_box:     valByIdOrLabel("shippingBoxSelect", "Shipping Box"),
        weight_lb:  (() => { const v = valByIdOrLabel("shipWeightLb", "Weight (lb)"); return v !== "" ? Number(v) : undefined; })(),
        weight_oz:  (() => { const v = valByIdOrLabel("shipWeightOz", "Weight (oz)"); return v !== "" ? Number(v) : undefined; })(),
        shipbx_length: (() => { const v = valByIdOrLabel("shipLength", "Length"); return v !== "" ? Number(v) : undefined; })(),
        shipbx_width:  (() => { const v = valByIdOrLabel("shipWidth", "Width"); return v !== "" ? Number(v) : undefined; })(),
        shipbx_height: (() => { const v = valByIdOrLabel("shipHeight", "Height"); return v !== "" ? Number(v) : undefined; })(),
      };
    
      if (isDraft) {
        // Send any non-empty fields for drafts (Basic + Marketplace)
        const inventory = prune(invAll);
        const listing   = prune(listingAll);
        const payload = { status: "draft", inventory };
        if (Object.keys(listing).length > 0) payload.listing = listing;
        // NOTE: we still omit marketplaces_selected for drafts for now
        return payload;
      }
    
      // Active/new items (unchanged behavior)
      const salesChannel = valByIdOrLabel("salesChannelSelect", "Sales Channel");
      const isStoreOnly = /store only/i.test(String(salesChannel || ""));
      const inventory = prune(invAll);
    
      if (isStoreOnly) {
        return { inventory };
      }
    
      const listing = prune(listingAll);
      const marketplaces_selected = Array.from(selectedMarketplaceIds.values());
      return { inventory, listing, marketplaces_selected };
    }

     async function submitIntake(mode = "active") {
      if (mode !== "draft" && !computeValidity()) return;
    
      const payload = buildPayload(mode === "draft");
      // If we’re editing an existing item, send its id so the server updates it
      if (__currentItemId) {
        payload.item_id = __currentItemId;
      }
      
      const res = await api("/api/inventory/intake", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
      if (!res || res.ok === false) {
          throw new Error(res?.error || "intake_failed");
        }

        // Save defaults (local) on success so user gets the same picks next time
        try {
          writeDefaults(Array.from(selectedMarketplaceIds.values()));
        } catch {}

        // Post-save UX: confirm, disable fields, and swap CTAs
        postSaveSuccess(res, mode);
        // Notify Drafts to reload now that an item changed (added/promoted/saved)
        document.dispatchEvent(new CustomEvent("intake:item-changed"));
      try {
        const skuEl = document.querySelector("[data-sku-out]");
        if (skuEl && res.sku) skuEl.textContent = res.sku;
      } catch {}
      // Success UX is up to you (toast, clear form, or route back to Inventory)
    }
    
    function wireCtas() {
      const activeIds = ["intake-submit", "intake-save", "intake-add-single", "intake-add-bulk"];
      const draftIds  = ["intake-draft"];

      // Buttons that create ACTIVE items
      const actById = activeIds.map(id => document.getElementById(id)).filter(Boolean);
      const actByText = Array.from(document.querySelectorAll("button, a[role='button']"))
        .filter(b => /add single item|add to bulk list/i.test((b.textContent || "").trim()));
      [...actById, ...actByText].forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            btn.disabled = true;
            await submitIntake("active");
          } catch (err) {
            console.error("intake:submit:error", err);
            alert("Failed to save. Please check required fields and try again.");
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Buttons that save DRAFTS
      const draftButtons = draftIds.map(id => document.getElementById(id)).filter(Boolean);
      draftButtons.forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            btn.disabled = true;
            await submitIntake("draft");
          } catch (err) {
            console.error("intake:draft:error", err);
            alert("Failed to save draft.");
          } finally {
            btn.disabled = false;
          }
        });
      });
    }

    // Remember original actions-row HTML so we can restore the 3 CTAs after editing
    let __originalCtasHTML = null;
    
    // Hold the current item id across edits so the next save updates, not creates
    let __currentItemId = null;

    /** Format a timestamp into a short local string */
    function fmtSaved(ts) {
      try {
        const d = new Date(ts);
        return isNaN(d.getTime()) ? "—" : d.toLocaleString();
      } catch { return "—"; }
    }
    
    /** Render a single draft row */
    function renderDraftRow(row) {
      const tr = document.createElement("tr");
      tr.className = "border-b";
      tr.innerHTML = `
        <td class="px-3 py-2 whitespace-nowrap">${fmtSaved(row.saved_at)}</td>
        <td class="px-3 py-2">${row.product_short_title || "—"}</td>
        <td class="px-3 py-2">${row.price != null ? `$${Number(row.price).toFixed(2)}` : "—"}</td>
        <td class="px-3 py-2">${row.qty ?? "—"}</td>
        <td class="px-3 py-2">${row.category_nm || "—"}</td>
        <td class="px-3 py-2">
          <div class="flex gap-2">
            <button type="button" class="btn btn-primary btn-sm" data-action="load" data-item-id="${row.item_id}">Load</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="delete" data-item-id="${row.item_id}">Delete</button>
          </div>
        </td>
      `;
      return tr;
    }
    
    /** Populate intake form controls from saved inventory + listing profile */
    function populateFromSaved(inv, listing) {
      // Basic Item Details
      const title = document.getElementById("titleInput") || findControlByLabel("Item Name / Description");
      if (title) title.value = inv?.product_short_title ?? "";
    
      const price = document.getElementById("priceInput") || findControlByLabel("Price (USD)");
      if (price) price.value = inv?.price ?? "";
    
      const qty = document.getElementById("qtyInput") || findControlByLabel("Qty");
      if (qty) qty.value = inv?.qty ?? "";
    
      const cat = document.getElementById("categorySelect") || findControlByLabel("Category");
      if (cat) cat.value = inv?.category_nm ?? "";
    
      const store = document.getElementById("storeLocationSelect") || findControlByLabel("Store Location");
      if (store) store.value = inv?.instore_loc ?? "";
    
      const cogs = document.getElementById("costInput") || findControlByLabel("Cost of Goods (USD)");
      if (cogs) cogs.value = inv?.cost_of_goods ?? "";
    
      const bin = document.getElementById("caseBinShelfInput") || findControlByLabel("Case#/Bin#/Shelf#");
      if (bin) bin.value = inv?.case_bin_shelf ?? "";
    
      const sales = document.getElementById("salesChannelSelect") || findControlByLabel("Sales Channel");
      if (sales) sales.value = inv?.instore_online ?? "";
    
      // Marketplace Listing Details (optional for drafts)
      if (listing) {
        const mpCat = document.getElementById("marketplaceCategorySelect") || findControlByLabel("Marketplace Category");
        if (mpCat) mpCat.value = listing.listing_category ?? "";
    
        const cond = document.getElementById("conditionSelect") || findControlByLabel("Condition");
        if (cond) cond.value = listing.item_condition ?? "";
    
        const brand = document.getElementById("brandSelect") || findControlByLabel("Brand");
        if (brand) brand.value = listing.brand_name ?? "";
    
        const color = document.getElementById("colorSelect") || findControlByLabel("Primary Color");
        if (color) color.value = listing.primary_color ?? "";
    
        const desc = document.getElementById("longDescriptionTextarea") || findControlByLabel("Long Description");
        if (desc) desc.value = listing.product_description ?? "";
    
        const shipBox = document.getElementById("shippingBoxSelect") || findControlByLabel("Shipping Box");
        if (shipBox) shipBox.value = listing.shipping_box ?? "";
    
        const lb  = document.getElementById("weightLbInput") || findControlByLabel("Weight (lb)");
        const oz  = document.getElementById("weightOzInput") || findControlByLabel("Weight (oz)");
        const len = document.getElementById("lengthInput")   || findControlByLabel("Length");
        const wid = document.getElementById("widthInput")    || findControlByLabel("Width");
        const hei = document.getElementById("heightInput")   || findControlByLabel("Height");
        if (lb)  lb.value  = listing.weight_lb ?? "";
        if (oz)  oz.value  = listing.weight_oz ?? "";
        if (len) len.value = listing.shipbx_length ?? "";
        if (wid) wid.value = listing.shipbx_width ?? "";
        if (hei) hei.value = listing.shipbx_height ?? "";
      }
    
      // Recompute validity / show or hide marketplace fields as needed
      try { setMarketplaceVisibility(); } catch {}
      try { computeValidity(); } catch {}
    }
    
    /** Enter existing-view mode (disabled fields + Edit/Add New/Delete CTAs) */
    function enterViewMode({ item_id, hasSku = false }) {
      __currentItemId = item_id;
    
      // Disable all fields
      try {
        const form = document.getElementById("intakeForm");
        if (form) {
          const ctrls = Array.from(form.querySelectorAll("input, select, textarea"));
          ctrls.forEach((el) => { el.disabled = true; el.readOnly = true; el.setAttribute("aria-disabled", "true"); });
        }
      } catch {}
    
      // Swap CTAs to Edit / Add New / Delete (mirror postSaveSuccess)
      try {
        const actionsRow = document.querySelector(".actions.flex.gap-2");
        if (actionsRow) {
          if (__originalCtasHTML == null) __originalCtasHTML = actionsRow.innerHTML;
          actionsRow.innerHTML = `
            <button id="btnEditItem" class="btn btn-primary btn-sm">Edit Item</button>
            <button id="btnAddNew" class="btn btn-ghost btn-sm">Add New Item</button>
            <button id="btnDeleteItem" class="btn btn-danger btn-sm">Delete</button>
          `;
          const btnEdit = document.getElementById("btnEditItem");
          const btnNew  = document.getElementById("btnAddNew");
          const btnDel  = document.getElementById("btnDeleteItem");
    
          if (btnEdit) btnEdit.addEventListener("click", (e) => {
            e.preventDefault();
            try {
              const form = document.getElementById("intakeForm");
              if (form) {
                const ctrls = Array.from(form.querySelectorAll("input, select, textarea"));
                ctrls.forEach((el) => { el.disabled = false; el.readOnly = false; el.removeAttribute("aria-disabled"); });
                if (hasSku) {
                  const cat = document.getElementById("categorySelect");
                  if (cat) { cat.disabled = true; cat.setAttribute("aria-disabled", "true"); }
                }
              }
            } catch {}
            // Restore original CTAs and rewire
            try {
              if (__originalCtasHTML != null) {
                actionsRow.innerHTML = __originalCtasHTML;
                wireCtas();
              }
            } catch {}
            computeValidity();
          });
    
          if (btnNew) btnNew.addEventListener("click", (e) => {
            e.preventDefault();
            window.location.reload();
          });
    
          if (btnDel) btnDel.addEventListener("click", async (e) => {
            e.preventDefault();
            try {
              if (!__currentItemId) return alert("No item to delete.");
              const sure = confirm("Delete this item? This cannot be undone.");
              if (!sure) return;
              btnDel.disabled = true;
              const resDel = await api("/api/inventory/intake", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "delete", item_id: __currentItemId }),
              });
              if (!resDel || resDel.ok === false) throw new Error(resDel?.error || "delete_failed");
              alert("Item deleted.");
              // Also refresh Drafts immediately (useful when the page is not fully reloaded yet)
              document.dispatchEvent(new CustomEvent("intake:item-changed"));
              window.location.reload();
            } catch (err) {
              console.error("intake:delete:error", err);
              alert("Failed to delete item.");
            } finally {
              btnDel.disabled = false;
            }
          });
        }
      } catch {}
    }
    
    /** Click handler: Load a draft into the form and switch to edit path */
    async function handleLoadDraft(item_id) {
      try {
        const res = await api(`/api/inventory/intake?item_id=${encodeURIComponent(item_id)}`, { method: "GET" });
        if (!res || res.ok === false) throw new Error(res?.error || "fetch_failed");
        populateFromSaved(res.inventory || {}, res.listing || null);
        // Photos: hydrate thumbnails from GET response
        bootstrapPhotos(Array.isArray(res.images) ? res.images : [], item_id);
        // Enter view mode (treat as previously-saved edit path). Drafts have no SKU.
        enterViewMode({ item_id, hasSku: !!res?.inventory?.sku });
      } catch (err) {
        console.error("drafts:load:error", err);
        alert("Failed to load draft.");
      }
    }
    
    /** Click handler: Delete a draft from the list */
    async function handleDeleteDraft(item_id, rowEl) {
      try {
        const sure = confirm("Delete this draft? This cannot be undone.");
        if (!sure) return;
        const res = await api("/api/inventory/intake", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "delete", item_id }),
        });
        if (!res || res.ok === false) throw new Error(res?.error || "delete_failed");
        // Remove row
        if (rowEl && rowEl.parentElement) rowEl.parentElement.removeChild(rowEl);
      } catch (err) {
        console.error("drafts:delete:error", err);
        alert("Failed to delete draft.");
      }
    }
    
    /** Load and render all pending drafts */
    async function loadDrafts() {
      try {
        const tbody = document.getElementById("recentDraftsTbody");
        if (!tbody) return;
        // Fetch recent drafts
        const res = await api("/api/inventory/drafts", { method: "GET" });
        if (!res || res.ok === false) throw new Error(res?.error || "drafts_failed");
        const rows = Array.isArray(res.rows) ? res.rows : [];
    
        // Clear tbody
        tbody.innerHTML = "";
        if (rows.length === 0) {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td class="px-3 py-2 text-gray-500" colspan="6">No drafts yet.</td>`;
          tbody.appendChild(tr);
          return;
        }
    
        // Render rows
        for (const r of rows) {
          const tr = renderDraftRow(r);
          tbody.appendChild(tr);
        }
    
        // Wire row buttons
        tbody.querySelectorAll("button[data-action]").forEach((btn) => {
          const action = btn.getAttribute("data-action");
          const id = btn.getAttribute("data-item-id");
          if (action === "load") {
            btn.addEventListener("click", () => handleLoadDraft(id));
          } else if (action === "delete") {
            btn.addEventListener("click", (e) => handleDeleteDraft(id, btn.closest("tr")));
          }
        });
      } catch (err) {
        console.error("drafts:load:error", err);
      }
    }

     // Make loadDrafts available to the refresh bus declared earlier
    try { window.__loadDrafts = loadDrafts; } catch {}
    
    wireCtas();

    // NEW: Photos bootstrap
    wirePhotoPickers();
    renderPhotosGrid();
    // Hydrate Photos state from API results and refresh the grid
    function bootstrapPhotos(images = [], itemId = null) {
      __currentItemId = itemId || __currentItemId;
    
      __photos = (images || [])
        .map(r => ({
          image_id: r.image_id,
          cdn_url: r.cdn_url,
          is_primary: !!r.is_primary,
          sort_order: Number(r.sort_order) || 0,
          r2_key: r.r2_key,
          width: r.width_px,
          height: r.height_px,
          bytes: r.bytes,
          content_type: r.content_type,
        }))
        .sort((a, b) => a.sort_order - b.sort_order);
    
      __pendingFiles = [];
      renderPhotosGrid();
    
      // Re-evaluate gating to ensure "Save as Draft" may enable based on photos
      try { computeValidity(); } catch {}
    }

      // After successful save: confirm, disable form controls, and swap CTAs
      function postSaveSuccess(res, mode) {
        try {
          // 1) Confirmation — show SKU when present, otherwise draft notice
          const skuPart = res?.sku ? `SKU ${res.sku}` : `Draft saved`;
          const msg = mode === "draft"
            ? `Saved draft (#${res?.item_id || "?"}).`
            : `Saved item ${skuPart} (#${res?.item_id || "?"}).`;
          alert(msg);
          // Remember the item id for subsequent edits/saves
          __currentItemId = res?.item_id || __currentItemId;
          // Also stash on the form for resilience (not strictly required)
          try {
            const form = document.getElementById("intakeForm");
            if (form && __currentItemId) form.dataset.itemId = __currentItemId;
          } catch (e) {}

          // NEW: notify photos module so it can flush any pending uploads
          try {
            document.dispatchEvent(new CustomEvent("intake:item-saved", { detail: { item_id: __currentItemId } }));
          } catch {}
          
        } catch {}
  
        // 2) Disable all form fields (inputs/selects/textareas)
        try {
          const form = document.getElementById("intakeForm");
          if (form) {
            const ctrls = Array.from(form.querySelectorAll("input, select, textarea"));
            ctrls.forEach(el => { el.disabled = true; el.readOnly = true; el.setAttribute("aria-disabled", "true"); });
          }
        } catch {}
  
        // 3) Replace the three CTAs with: Edit Item + Add New Item
        try {
          // Find the first actions row that contains our intake buttons
          const actionsRow = document.querySelector(".actions.flex.gap-2");
          if (actionsRow) {
            const itemId = res?.item_id || "";
        
            // Capture original CTAs the first time we swap them out
            if (__originalCtasHTML == null) {
              __originalCtasHTML = actionsRow.innerHTML;
            }
        
            // Swap to Edit / Add New
            actionsRow.innerHTML = `
              <button id="btnEditItem" class="btn btn-primary btn-sm">Edit Item</button>
              <button id="btnAddNew" class="btn btn-ghost btn-sm">Add New Item</button>
              <button id="btnDeleteItem" class="btn btn-danger btn-sm">Delete</button>
            `;
        
            const btnEdit = document.getElementById("btnEditItem");
            const btnNew  = document.getElementById("btnAddNew");
        
            if (btnEdit) {
              btnEdit.addEventListener("click", (e) => {
                e.preventDefault();
        
               // (1) Re-enable form fields, and lock Category ONLY if a SKU already exists
              try {
                const form = document.getElementById("intakeForm");
                if (form) {
                  const ctrls = Array.from(form.querySelectorAll("input, select, textarea"));
                  ctrls.forEach((el) => {
                    el.disabled = false;
                    el.readOnly = false;
                    el.removeAttribute("aria-disabled");
                  });
              
                  // If the last save returned a SKU, do not allow Category edits
                  const hasSku = !!(res && res.sku);
                  if (hasSku) {
                    const cat = document.getElementById("categorySelect");
                    if (cat) {
                      cat.disabled = true;
                      cat.setAttribute("aria-disabled", "true");
                      const hint = document.getElementById("categoryCodeHint");
                      if (hint) hint.textContent = "Category locked (SKU assigned)";
                    }
                  }
                }
              } catch (err) { /* no-op */ }
        
                // (2) Restore the original 3 CTAs and re-wire their handlers
                try {
                  if (__originalCtasHTML != null) {
                    actionsRow.innerHTML = __originalCtasHTML;
                  }
                  // Reattach events to the restored buttons
                  wireCtas();
                } catch (err) { /* no-op */ }
        
                // (3) Remove success banner (if present) and re-validate to toggle button disabled states
                try {
                  const banner = document.getElementById("intake-save-banner");
                  if (banner) banner.remove();
                } catch (err) { /* no-op */ }
                computeValidity();
        
                // (4) Optional: focus the first field for convenience
                try {
                  const first = document.querySelector("#intakeForm input, #intakeForm select, #intakeForm textarea");
                  if (first) first.focus();
                } catch (err) { /* no-op */ }
              });
            }
        
            if (btnNew) {
              btnNew.addEventListener("click", (e) => {
                e.preventDefault();
                // Reload the intake screen to start a fresh item
                window.location.reload();
              });
            }

            const btnDel = document.getElementById("btnDeleteItem");
            if (btnDel) {
              btnDel.addEventListener("click", async (e) => {
                e.preventDefault();
                try {
                  if (!__currentItemId) return alert("No item to delete.");
                  const sure = confirm("Delete this item? This cannot be undone.");
                  if (!sure) return;
                  btnDel.disabled = true;
                  const resDel = await api("/api/inventory/intake", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "delete", item_id: __currentItemId }),
                  });
                  if (!resDel || resDel.ok === false) {
                    throw new Error(resDel?.error || "delete_failed");
                  }
                  alert("Item deleted.");
                  window.location.reload();
                } catch (err) {
                  console.error("intake:delete:error", err);
                  alert("Failed to delete item.");
                } finally {
                  btnDel.disabled = false;
                }
              });
            }

            
          }
        } catch (err) { /* no-op */ }
      }
  
    
  
  
    
  } catch (err) {
    console.error("Meta load failed:", err);
    const denied = document.getElementById("intake-access-denied");
    if (denied) denied.classList.remove("hidden");
  } finally {
    try { document.body.classList.remove("loading"); } catch {}
  }
}

// end intake js file. 
