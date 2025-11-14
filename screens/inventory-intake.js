import { api } from "/assets/js/api.js";

// Exported so router can call it: router awaits `mod.init(...)` after importing this module.
// (See assets/js/router.js for the dynamic import and named-export call.)
export async function init() {
  // Lightweight loading flag
  try { document.body.classList.add("loading"); } catch {}

  // ——— Local helpers (screen-scoped) ———
  const $ = (id) => document.getElementById(id);
  // --- Default Long Description for new items ---
  const BASE_DESCRIPTION =
    "The photos are part of the description. Be sure to look them over for condition and details. This is sold as is, and it's ready for a new home.";
  
  function ensureDefaultLongDescription() {
    const el =
      document.getElementById("longDescriptionTextarea") ||
      findControlByLabel("Long Description");
    if (!el) return;
  
    const val = String(el.value || "").trim();
    // If user/server already filled it, leave it alone
    if (val && val !== "Enter a detailed description…") return;
  
    // Pull Item Name / Description and prepend it above the base sentence
    const titleEl = document.getElementById("titleInput") || findControlByLabel("Item Name / Description");
    const title = String(titleEl?.value || "").trim();
  
    el.value = title ? `${title}\n\n${BASE_DESCRIPTION}` : BASE_DESCRIPTION;
  }
  
  // ====== Photos state & helpers (NEW) ======
  const MAX_PHOTOS = 15;
  let __photos = [];              // [{image_id, cdn_url, is_primary, sort_order, r2_key, width, height, bytes, content_type}]
  let __pendingFiles = [];        // Files awaiting upload (before item_id exists)
  let __currentItemId = null;     // sync with existing flow
  let __reorderMode = false;
  let __lockDraft = false;        // Phase 0: once Active, we never allow reverting to Draft (UI lock)
  // Stash the tenant id once we learn it (from /api/inventory/meta or DOM)
  let __tenantId = "";
  let __duplicateSourceImages = [];
  
   // When duplicating an item, this flag controls whether we carry photos from the template.
      // Default is true; the duplicate prompt can flip it off for the new item.
      let __duplicateCarryPhotos = true;
  
  console.log("[photos:init]", {
    MAX_PHOTOS,
    __photosLen: __photos.length,
    __pendingLen: __pendingFiles.length,
    __currentItemId,
    __tenantId,
  });
  
  // Utility: update counter + disable add when maxed
  function updatePhotosUIBasic() {
    const count = __photos.length + __pendingFiles.length;
    const cap = `${count} / ${MAX_PHOTOS}`;
    const el = $("photosCount");
    if (el) el.textContent = cap;

    console.log("[photos] updatePhotosUIBasic", {
      count,
      photosLen: __photos.length,
      pendingLen: __pendingFiles.length,
      currentItemId: __currentItemId,
    });
    
    const canAdd = count < MAX_PHOTOS;
    const cam = $("photoCameraInput");
    const fil = $("photoFileInput");
    if (cam) cam.disabled = !canAdd;
    if (fil) fil.disabled = !canAdd;
  }
  
// Render thumbnails
  function renderPhotosGrid() {
    const host = $("photosGrid");
    if (!host) {
      console.warn("[photos] renderPhotosGrid: host #photosGrid not found", {
        photosLen: __photos.length,
        pendingLen: __pendingFiles.length,
        currentItemId: __currentItemId,
      });
      return;
    }
    console.log("[photos] renderPhotosGrid", {
      photosLen: __photos.length,
      pendingLen: __pendingFiles.length,
      currentItemId: __currentItemId,
      duplicateSourceCount: Array.isArray(__duplicateSourceImages) ? __duplicateSourceImages.length : 0,
    });
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
      // Reuse the persistent preview URL and carry a stable pending_id
      const preview = f._previewUrl || URL.createObjectURL(f);
      host.appendChild(
        renderThumb({ cdn_url: preview, pending_id: f._rpId, is_primary: false }, { pending: true })
      );
    }
  
    updatePhotosUIBasic();
    // Nudge gating when photo count changes (add/replace/delete/reorder)
    try { computeValidity(); } catch {}
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
          // remove THE clicked pending file by its stable id
          const idx = __pendingFiles.findIndex(f => f && f._rpId && f._rpId === model.pending_id);
          if (idx >= 0) {
            try { if (__pendingFiles[idx]._previewUrl) URL.revokeObjectURL(__pendingFiles[idx]._previewUrl); } catch {}
            __pendingFiles.splice(idx, 1);
          }
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
    console.log("[photos] uploadAndAttach called", {
      hasItemId: !!__currentItemId,
      fileName: file?.name,
      size: file?.size,
      pendingId: file?._rpId || null,
      cropOfImageId,
    });
    if (!__currentItemId) {
      // Give each pending file a stable identity and a persistent preview URL.
      if (!file._rpId) {
        file._rpId = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
      }
      if (!file._previewUrl) {
        file._previewUrl = URL.createObjectURL(file);
      }
      const before = __pendingFiles.length;
      __pendingFiles.push(file);
      console.log("[photos] queued file in __pendingFiles (no item_id yet)", {
        before,
        after: __pendingFiles.length,
        _rpId: file._rpId,
      });
      renderPhotosGrid();
      return;
    }
    const body = new FormData();
    body.append("file", file);
    
    // IMPORTANT: bypass api() for multipart so the browser sets the boundary.
    // Do NOT set content-type here.
    // Resolve tenant id the same way other calls do (fallbacks are safe if api() isn’t available here)
    // Resolve tenant id (prefer what we got from the meta API)
    const metaTag = document.querySelector('meta[name="x-tenant-id"]');
    const TENANT_ID =
      __tenantId ||
      (metaTag && metaTag.getAttribute("content")) ||
      document.documentElement.getAttribute("data-tenant-id") ||
      localStorage.getItem("rp:tenant_id") ||
      "";
    
    // Upload via centralized api(); it will keep FormData boundaries and add x-tenant-id automatically.
    const up = await api(
      `/api/images/upload?item_id=${encodeURIComponent(__currentItemId)}&filename=${encodeURIComponent(file.name)}`,
      { method: "POST", body }
    );
    if (!up || up.ok === false) throw new Error(up?.error || "upload_failed");

    const at = await api("/api/images/attach", {
      method: "POST",
      body: {
        item_id: __currentItemId,
        ...up
      }
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
    console.log("[photos] __photos updated after upload", {
      photosLen: __photos.length,
      lastImageId: at.image_id,
    });
    renderPhotosGrid();
    try { computeValidity(); } catch {}
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
    const ds = await downscaleToBlob(f);
    if (!ds._rpId) ds._rpId = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
    if (!ds._previewUrl) ds._previewUrl = URL.createObjectURL(ds);
    await uploadAndAttach(ds);
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
      try { computeValidity(); } catch {}
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
      try { computeValidity(); } catch {}
    });
  
    $("photoReorderToggle")?.addEventListener("click", ()=>{
      __reorderMode = !__reorderMode;
      renderPhotosGrid();
      alert(__reorderMode ? "Reorder ON: drag photos to rearrange." : "Reorder OFF");
    });
  
      document.addEventListener("intake:item-saved", async (ev) => {
      try {

        console.groupCollapsed("[intake.js] intake:item-saved");
        console.log("detail", {
          item_id: ev?.detail?.item_id,
          action: ev?.detail?.action,
          save_status: ev?.detail?.save_status,
          job_ids: ev?.detail?.job_ids
        });
        
        const id         = ev?.detail?.item_id;
        const saveStatus = String(ev?.detail?.save_status || "").toLowerCase(); // "active" | "draft" | "delete"
        const action     = String(ev?.detail?.action || (saveStatus === "delete" ? "delete" : "save")).toLowerCase();
        const jobIds     = Array.isArray(ev?.detail?.job_ids) ? ev.detail.job_ids : [];
        if (!id) { console.warn("[intake.js] intake:item-saved missing item_id"); console.groupEnd?.(); return; }
        __currentItemId = id;
        
        
        // Phase 0: once Active, permanently lock Draft action for this listing (UI)
        if (saveStatus === "active") {
          __lockDraft = true;
          const draftBtn = document.getElementById("intake-draft");
          if (draftBtn) {
            draftBtn.disabled = true;
            draftBtn.classList.add("opacity-60", "cursor-not-allowed");
            draftBtn.title = "Draft save is disabled for Active listings.";
          }
          // Also enable the Xeasy copy button after successful Active save (create/update)
          try { enableCopyXeasy(true); } catch {}
        }
        
        
       if (__pendingFiles.length > 0) {
          console.log("[photos] flushing pending files after save", {
            pendingCount: __pendingFiles.length,
            currentItemId: __currentItemId,
            pendingIds: __pendingFiles.map(f => f?._rpId || null),
          });
          const pending = __pendingFiles.splice(0, __pendingFiles.length);
          for (const f of pending) {
            console.log("[photos] uploading pending file", {
              _rpId: f?._rpId || null,
              name: f?.name,
              size: f?.size,
            });
            await uploadAndAttach(f);
          }
          console.log("[photos] pending flush complete", {
            remainingPending: __pendingFiles.length,
            photosLen: __photos.length,
          });
        } else {
          console.log("[photos] no pending files to flush on save", {
            currentItemId: __currentItemId,
          });
        }
    
       // If server returned marketplace job_ids, kick the runner regardless of action
      if (jobIds.length > 0) {
        const isDelete = action === "delete" || saveStatus === "delete";
        setEbayStatus(isDelete ? "Deleting…" : "Publishing…", { tone: "info" });
    
          for (const jid of jobIds) {
            try {
              console.log("[intake.js] kick job", { job_id: jid });
              fetch(`/api/marketplaces/publish/run?job_id=${encodeURIComponent(jid)}`, { method: "POST" })
                .then((r) => r.ok ? null : r.text().then(t => console.warn("[intake.js] job kick non-200", { job_id: jid, status: r.status, body: t })))
                .catch((e) => console.warn("[intake.js] job kick error", { job_id: jid, error: String(e) }));
            } catch {}
            trackPublishJob(jid);
           }
        }

        // When the save is Active, photos are flushed, and eBay jobs are quiet,
        // this will emit `intake:facebook-ready` ONLY if Facebook is selected
        // and not already live for this item.
        await __emitFacebookReadyIfSafe({ saveStatus, jobIds });
        // Immediately reconcile the Facebook card with the DB snapshot
        try { await refreshFacebookTile(); } catch {}
      } catch (e) {
        console.error("photos:flush:error", e);
      } finally {
        console.groupEnd?.();
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
    // normalize: remove colons, asterisks and collapse whitespace
    const norm = (s) => String(s || "")
      .replace(/[:*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  
    const want = norm(labelText);
    const labels = Array.from(document.querySelectorAll("label"));
    const lbl = labels.find(l => norm(l.textContent) === want);
    if (!lbl) return null;
  
    if (lbl.htmlFor) {
      const byId = document.getElementById(lbl.htmlFor);
      if (byId) return byId;
    }
    // fallback: the first input/select/textarea after the label
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
      // Key by UUID so it matches <option value="box_key">
      map[r.box_key] = {
        lb: r.weight_lb, oz: r.weight_oz, len: r.length, wid: r.width, hei: r.height,
      };
    }
  
    const enableAll = () => { inputs.forEach((el) => { el.disabled = false; el.readOnly = false; }); };
    const clearAll  = () => { inputs.forEach((el) => { el.value = ""; }); };
  
    const hasMetaValues = (m) => !!m && ![m.lb, m.oz, m.len, m.wid, m.hei].every(v => v == null || v === "");

    const update = () => {
      enableAll(); // always allow typing
      const key = sel.value; // this is box_key
      const m = map[key];
    
      // No selection or unknown row => manual
      if (!key || !m) { clearAll(); try { computeValidity(); } catch {} return; }
    
      // Row exists but empty (e.g., "Custom Box") => manual
      if (!hasMetaValues(m)) { clearAll(); try { computeValidity(); } catch {} return; }
    
      // Prefill numbers (still editable)
      if (lb)  lb.value  = `${m.lb ?? ""}`;
      if (oz)  oz.value  = `${m.oz ?? ""}`;
      if (len) len.value = `${m.len ?? ""}`;
      if (wid) wid.value = `${m.wid ?? ""}`;
      if (hei) hei.value = `${m.hei ?? ""}`;
    
      // Re-validate so CTAs can enable immediately after selection
      try { computeValidity(); } catch {}
    };

    // run on change + once on load
    sel.addEventListener("change", update);
    try { update(); } catch {}
    
    // CLOSE wireShippingBoxAutofill(meta)
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
          if (mpCat) mpCat.value = listing.listing_category_key ?? "";
        
          const cond = document.getElementById("conditionSelect") || findControlByLabel("Condition");
          if (cond) cond.value = listing.condition_key ?? "";
        
          const brand = document.getElementById("brandSelect") || findControlByLabel("Brand");
          if (brand) brand.value = listing.brand_key ?? "";
        
          const color = document.getElementById("colorSelect") || findControlByLabel("Primary Color");
          if (color) color.value = listing.color_key ?? "";
        
          const shipBox = document.getElementById("shippingBoxSelect") || findControlByLabel("Shipping Box");
          if (shipBox) shipBox.value = listing.shipping_box_key ?? "";

         // Long Description (textarea)
        const longDesc = document.getElementById("longDescriptionTextarea") || findControlByLabel("Long Description");
        if (longDesc) {
          const current = String(listing?.product_description ?? "").trim();
          if (current) {
            // If server already has a description, use it as-is
            longDesc.value = current;
          } else {
            // Otherwise, compose: <Title> + blank line + base sentence
            const titleEl = document.getElementById("titleInput") || findControlByLabel("Item Name / Description");
            const title = String(titleEl?.value || inv?.product_short_title || "").trim();
            longDesc.value = title ? `${title}\n\n${BASE_DESCRIPTION}` : BASE_DESCRIPTION;
          }
        }
          
    

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

  
    // Hydrate UI from a duplicate seed stashed in sessionStorage (if any)
      function maybePromptDuplicatePhotos() {
        try {
          if (!Array.isArray(__duplicateSourceImages) || __duplicateSourceImages.length === 0) return;

          const dlg   = $("duplicatePhotosDialog");
          const yesBtn = $("duplicatePhotosYes");
          const noBtn  = $("duplicatePhotosNo");

          if (!dlg || !yesBtn || !noBtn) return;

          // Avoid wiring twice if called again
          if (dlg.dataset.wired === "1") {
            try { dlg.showModal(); } catch {}
            return;
          }

          dlg.dataset.wired = "1";

          yesBtn.onclick = () => {
            __duplicateCarryPhotos = true;
            try { dlg.close(); } catch {}
          };

          noBtn.onclick = () => {
            __duplicateCarryPhotos = false;
            // Clear duplicated photos so the user starts fresh
            __duplicateSourceImages = [];
            __photos = [];
            try { renderPhotosGrid(); } catch {}
            try { computeValidity(); } catch {}
            try { dlg.close(); } catch {}
          };

          try { dlg.showModal(); } catch {}
        } catch (e) {
          console.warn("[duplicateSeed] photo prompt failed", e);
        }
      }
      function hydrateFromDuplicateSeed() {
        console.groupCollapsed?.("[duplicateSeed] hydrateFromDuplicateSeed:start");
        let raw = null;
        try {
          raw = sessionStorage.getItem("rp:intake:duplicateSeed");
        } catch (e) {
          console.warn("[intake.js] duplicateSeed: sessionStorage unavailable", e);
          console.groupEnd?.();
          return false;
        }
        if (!raw) return false;

        let seed;
        try {
          seed = JSON.parse(raw);
        } catch (e) {
          console.error("[intake.js] duplicateSeed: parse failed", e);
          try { sessionStorage.removeItem("rp:intake:duplicateSeed"); } catch {}
          console.groupEnd?.();
          return false;
        }

        // Consume the seed so it only applies once
        try { sessionStorage.removeItem("rp:intake:duplicateSeed"); } catch {}
        
        const inv     = seed?.inventory || {};
        const listing = seed?.listing   || null;
        const images  = Array.isArray(seed?.images) ? seed.images : [];

        console.log("[duplicateSeed] parsed", {
          hasInventory: !!inv,
          hasListing: !!listing,
          imageCount: images.length,
          cdnSample: images.slice(0, 5).map(i => i?.cdn_url || null),
        });

        // Force "new item" state
        __currentItemId    = null;
        __pendingFiles     = [];
        __duplicateSourceImages = images.map((img, idx) => ({
          r2_key: img.r2_key,
          cdn_url: img.cdn_url,
          bytes: img.bytes,
          content_type: img.content_type,
          width: img.width ?? img.width_px ?? null,
          height: img.height ?? img.height_px ?? null,
          sha256: img.sha256 ?? img.sha256_hex ?? null,
          sort_order: typeof img.sort_order === "number" ? img.sort_order : idx,
          is_primary: !!img.is_primary,
        }));
        console.log("[duplicateSeed] mapped duplicateSourceImages", {
          duplicateSourceCount: __duplicateSourceImages.length,
        });
        
        // Thumbnails only – no uploads yet
        __photos = __duplicateSourceImages.map((img, idx) => ({
          image_id: "dup-" + (typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${idx}`),
          cdn_url: img.cdn_url,
          is_primary: !!img.is_primary,
          sort_order: typeof img.sort_order === "number" ? img.sort_order : idx,
        }));

        console.log("[duplicateSeed] initial thumbnails populated", {
          photosLen: __photos.length,
        });

        // Hydrate form + photos (thumbnails only; originals will be cloned on the server)
        try {
          populateFromSaved(inv, listing);
        } catch (e) {
          console.error("[intake.js] populateFromSaved failed for duplicateSeed", e);
        }

        try {
          renderPhotosGrid();
        } catch (e) {
          console.error("[intake.js] renderPhotosGrid failed for duplicateSeed", e);
        }

        try {
          computeValidity();
        } catch {}

        console.log("[intake.js] hydrated from duplicateSeed", {
          hasListing: !!listing,
          imageCount: __photos.length,
          pendingLen: __pendingFiles.length,
        });
        console.groupEnd?.();
        return true;
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
  
    // DRAFT CTA:
    // - Normally enables if Title or at least 1 photo
    // - If __lockDraft is true, force-disable and annotate
    const title = resolveControl(null, "Item Name / Description");
    const hasTitle = !!title && String(title.value || "").trim() !== "";
    const photoCount = (__photos?.length || 0) + (__pendingFiles?.length || 0);
    const hasAnyPhoto = photoCount >= 1;
    const draftBtn = document.getElementById("intake-draft");
    if (draftBtn) {
      const draftOk = !__lockDraft && (hasTitle || hasAnyPhoto);
      draftBtn.disabled = !draftOk;
      draftBtn.classList.toggle("opacity-60", !draftOk);
      draftBtn.classList.toggle("cursor-not-allowed", !draftOk);
      draftBtn.title = __lockDraft
        ? "Draft save is disabled for Active listings."
        : "";
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
    // Base marketplace + shipping fields (only when visible & enabled)
    const base = MARKETPLACE_REQUIRED
      .map(({ id, label }) => resolveControl(id, label))
      .filter(Boolean)
      .filter((n) => {
        if (!n || n.disabled || n.type === "hidden") return false;
        if (n.closest(".hidden")) return false;
        if (n.offsetParent === null) return false;
        return true;
      });

     // Determine if the eBay tile is actually selected right now.
    // If not selected, we must NOT treat eBay fields as required.
    const ebaySelected = (() => {
      const rows = (__metaCache?.marketplaces || []);
      const byId = new Map(rows.map(r => [Number(r.id), String(r.slug || "").toLowerCase()]));
      for (const id of selectedMarketplaceIds) {
        if (byId.get(Number(id)) === "ebay") return true;
      }
      return false;
    })();

    // eBay card fields (when the eBay card is rendered and the fields are visible)
    const ebaySelectors = [
      "#ebay_shippingPolicy",
      "#ebay_paymentPolicy",
      "#ebay_returnPolicy",
      "#ebay_shipZip",
      "#ebay_formatSelect",
      "#ebay_bin",

      // These are conditionally shown; include only if visible
      "#ebay_duration",
      "#ebay_start",
      "#ebay_autoAccept",
      "#ebay_minOffer",
      "#ebay_promotePct"
    ];

    const ebayNodes = ebaySelectors
      .map(sel => document.querySelector(sel))
      .filter(Boolean)
      .filter((n) => {
        if (!n || n.disabled || n.type === "hidden") return false;
        if (n.closest(".hidden")) return false;       // hidden by class (format/best-offer/promote toggles)
        if (n.offsetParent === null) return false;    // not in layout flow
        return true;
      });

    return [...base, ...ebayNodes];
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
  // Host for marketplace cards (placeholder UIs per selected marketplace)
  const MP_CARDS_ID = "marketplaceCards";
  
  // Cache latest meta so we can re-render cards on tile toggles
  let __metaCache = null;
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

      // initial pressed state comes only from selectedMarketplaceIds
      const isSelected = selectedMarketplaceIds.has(Number(m.id));
      if (enabledSelectable && isSelected) {
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
          // Delta-mode: add/remove cards without resetting existing card inputs
          try { renderMarketplaceCards(__metaCache, { mode: "delta" }); } catch {}
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

  // Apply per-item marketplace selection (e.g., when loading an existing item).
  // meta: inventory meta (usually __metaCache)
  // marketplaceListing: res.marketplace_listing from GET /api/inventory/intake
    function applyMarketplaceSelectionForItem(meta, marketplaceListing) {
    try {
      const rows = (meta?.marketplaces || []);
      const bySlug = new Map(
        rows.map(r => [String(r.slug || "").toLowerCase(), r])
      );

      selectedMarketplaceIds.clear();

      if (marketplaceListing) {
        const ids = [];

        // eBay row present -> include eBay marketplace id
        if (marketplaceListing.ebay) {
          const rawId =
            marketplaceListing.ebay_marketplace_id ??
            (bySlug.get("ebay") && bySlug.get("ebay").id);
          if (rawId != null) {
            const id = Number(rawId);
            if (!Number.isNaN(id)) ids.push(id);
          }
        }

        // Facebook row present -> include Facebook marketplace id
        if (marketplaceListing.facebook) {
          const rawId =
            marketplaceListing.facebook_marketplace_id ??
            (bySlug.get("facebook") && bySlug.get("facebook").id);
          if (rawId != null) {
            const id = Number(rawId);
            if (!Number.isNaN(id)) ids.push(id);
          }
        }

        for (const id of ids) {
          selectedMarketplaceIds.add(id);
        }
      }

      renderMarketplaceTiles(meta);
      // When hydrating an existing item, do a full rebuild of cards
      try { renderMarketplaceCards(meta, { mode: "full" }); } catch {}
    } catch (e) {
      console.error("marketplaces:applySelection:error", e);
    }
  }



    // Render placeholder cards for each selected marketplace (UI-only; no API calls)
  // opts.mode: "full" | "delta"
  //  - "full"  → rebuild all cards (used on initial load / item load)
  //  - "delta" → add/remove cards without touching existing ones (used on tile clicks)
  function renderMarketplaceCards(meta, opts) {
    const host = document.getElementById(MP_CARDS_ID);
    if (!host) return;

    const mode = (opts && opts.mode) || "full";

    // Install delegated listeners once so any field edit re-checks validity
    if (!host.dataset.validHook) {
      const safeRecheck = () => { try { computeValidity(); } catch {} };
      host.addEventListener("input", safeRecheck);
      host.addEventListener("change", safeRecheck);
      host.dataset.validHook = "1";
    }

    // Build a lookup of marketplaces by id (id, slug, marketplace_name, is_connected etc.)
    const rows = (meta?.marketplaces || []).filter(m => m.is_active !== false);
    const byId = new Map(rows.map(r => [Number(r.id), r]));
    const desiredIds = Array.from(selectedMarketplaceIds).map(Number);

    // Capture existing per-card statuses (by marketplace id) before a full rebuild
    const prevStatuses = new Map();
    if (mode === "full") {
      try {
        for (const card of Array.from(host.querySelectorAll("[data-marketplace-id]"))) {
          const mid = Number(card.dataset.marketplaceId);
          const node = card.querySelector("[data-status-text]");
          if (!Number.isNaN(mid) && node) {
            prevStatuses.set(mid, node.innerHTML || node.textContent || "");
          }
        }
      } catch {}
    }

    // Track which ids already have a card we can keep (delta mode)
    const realized = new Set();
    if (mode === "delta") {
      const existing = Array.from(host.querySelectorAll("[data-marketplace-id]"));
      for (const card of existing) {
        const mid = Number(card.dataset.marketplaceId);
        if (!desiredIds.includes(mid)) {
          card.remove(); // tile was deselected → drop its card
          continue;
        }
        realized.add(mid); // keep this card (and its current field values) as-is
      }
    } else {
      // full reset: start from a clean container
      host.innerHTML = "";
    }

    function createMarketplaceCard(m, prevStatusHtml) {
      const slug = String(m.slug || "").toLowerCase();
      const name = m.marketplace_name || m.slug || `#${m.id}`;
      const connected = !!m.is_connected;

      // Card wrapper
      const card = document.createElement("div");
      card.className = "card p-3";
      card.dataset.marketplaceId = String(m.id);

      // --- Header ---
      const header = document.createElement("div");
      header.className = "flex items-center justify-between mb-2";
      header.innerHTML = `
        <div class="flex items-center gap-2">
          <span class="font-semibold">${name}</span>
          <span class="text-xs px-2 py-1 rounded ${connected ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}">
            ${connected ? "Connected" : "Not connected"}
          </span>
        </div>
        <div class="text-sm" data-card-status>
          <strong>Status:</strong> <span class="mono" data-status-text>Not Listed</span>
          <button type="button" class="btn btn-ghost btn-xs ml-2 hidden" data-delist>Delist</button>
        </div>
      `;
      card.appendChild(header);

      // Restore any previously displayed status for this marketplace card (on full rebuilds)
      if (prevStatusHtml) {
        try {
          const node = header.querySelector("[data-status-text]");
          if (node) node.innerHTML = prevStatusHtml;
        } catch {}
      }

      // --- Body (placeholder fields) ---
      const body = document.createElement("div");
      body.className = "mt-2";

      if (slug === "ebay") {
        // eBay placeholder UI — all fields required unless hidden by rules
        body.innerHTML = `
          <div class="legacy-grid-2 gap-3">
            <div class="field">
              <label>Shipping Policy <span class="text-red-600" aria-hidden="true">*</span></label>
              <select id="ebay_shippingPolicy" required enabled title="Data wiring in later phase">
                <option value="">&lt;select&gt;</option>
              </select>
            </div>
            <div class="field">
              <label>Payment Policy <span class="text-red-600" aria-hidden="true">*</span></label>
              <select id="ebay_paymentPolicy" required enabled title="Data wiring in later phase">
                <option value="">&lt;select&gt;</option>
              </select>
            </div>
            <div class="field">
              <label>Return Policy <span class="text-red-600" aria-hidden="true">*</span></label>
              <select id="ebay_returnPolicy" required enabled title="Data wiring in later phase">
                <option value="">&lt;select&gt;</option>
              </select>
            </div>
            <div class="field">
              <label>Shipping Location (Zip) <span class="text-red-600" aria-hidden="true">*</span></label>
              <input id="ebay_shipZip" type="text" inputmode="numeric" pattern="[0-9]{5}" placeholder="e.g. 80903" required />
            </div>

            <div class="field">
              <label>Pricing Format <span class="text-red-600" aria-hidden="true">*</span></label>
              <select id="ebay_formatSelect" required>
                <option value="">&lt;select&gt;</option>
                <option value="fixed">Fixed Price</option>
                <option value="auction">Auction</option>
              </select>
            </div>

            <!-- Auction-only -->
            <div class="field ebay-auction-only hidden">
              <label>Duration <span class="text-red-600" aria-hidden="true">*</span></label>
              <select id="ebay_duration" required>
                <option value="">&lt;select&gt;</option>
                <option value="3">3 Days</option>
                <option value="5">5 Days</option>
                <option value="7">7 Days</option>
                <option value="10">10 Days</option>
              </select>
            </div>

            <div class="field">
              <label>Buy It Now Price (USD) <span class="text-red-600" aria-hidden="true">*</span></label>
              <input id="ebay_bin" type="number" step="0.01" min="0" placeholder="0.00" required />
            </div>

            <!-- Auction-only -->
            <div class="field ebay-auction-only hidden">
              <label>Starting Bid (USD) <span class="text-red-600" aria-hidden="true">*</span></label>
              <input id="ebay_start" type="number" step="0.01" min="0" placeholder="0.00" required />
            </div>
            <div class="field ebay-auction-only hidden">
              <label>Reserve Price (USD)</label>
              <input id="ebay_reserve" type="number" step="0.01" min="0" placeholder="0.00" />
            </div>

            <!-- Fixed-only -->
            <div class="field ebay-fixed-only">
              <label class="switch" for="ebay_bestOffer">
                <input id="ebay_bestOffer" type="checkbox" />
                <span class="slider"></span>
                <span class="switch-label">Allow Best Offer</span>
              </label>
            </div>
            <div class="field wide ebay-fixed-only ebay-bestoffer-only hidden">
              <div class="subgrid-2">
                <div class="field">
                  <label>Auto-accept (USD) <span class="text-red-600" aria-hidden="true">*</span></label>
                  <input id="ebay_autoAccept" type="number" step="0.01" min="0" placeholder="0.00" required />
                </div>
                <div class="field">
                  <label>Minimum offer (USD) <span class="text-red-600" aria-hidden="true">*</span></label>
                  <input id="ebay_minOffer" type="number" step="0.01" min="0" placeholder="0.00" required />
                </div>
              </div>
            </div>

            <!-- Promote -->
            <div class="field">
              <label class="switch" for="ebay_promote">
                <input id="ebay_promote" type="checkbox" />
                <span class="slider"></span>
                <span class="switch-label">Promote</span>
              </label>
            </div>
            <div class="field wide ebay-promote-only hidden">
              <label>Promotion Percent (%) <span class="text-red-600" aria-hidden="true">*</span></label>
              <input id="ebay_promotePct" type="number" step="0.1" min="0" max="100" placeholder="0" required />
            </div>
          `;
        card.appendChild(body);

        // If tenant is connected to eBay, pull policies and populate the selects
        (async () => {
          try {
            if (!connected) return; // leave disabled if not connected
            const pol = await api("/api/marketplaces/ebay/policies", { method: "GET" });
            if (!pol || pol.ok === false) return;

            const shipSel = body.querySelector("#ebay_shippingPolicy");
            const paySel  = body.querySelector("#ebay_paymentPolicy");
            const retSel  = body.querySelector("#ebay_returnPolicy");

            // Use existing helper; map { id, name }
            fillSelect(shipSel, pol.shipping || [], { textKey: "name", valueKey: "id" });
            fillSelect(paySel,  pol.payment  || [], { textKey: "name", valueKey: "id" });
            fillSelect(retSel,  pol.returns  || [], { textKey: "name", valueKey: "id" });

            // Enable once options are loaded
            [shipSel, paySel, retSel].forEach(s => { if (s) { s.disabled = false; s.title = ""; } });

            // Re-apply any saved policy ids AFTER options are present (fixes race on Load)
            try {
              const saved = (window && window.__ebaySavedPolicies) || null;
              if (saved) {
                if (shipSel) shipSel.value = saved.shipping_policy ?? "";
                if (paySel)  paySel.value  = saved.payment_policy  ?? "";
                if (retSel)  retSel.value  = saved.return_policy   ?? "";
                // Nudge validity/UX
                shipSel?.dispatchEvent(new Event("change"));
                paySel?.dispatchEvent(new Event("change"));
                retSel?.dispatchEvent(new Event("change"));
                try { computeValidity(); } catch {}
              }
            } catch {}
          } catch (e) {
            console.warn("ebay policies load failed", e);
          }
        })();

        // Wire local show/hide inside the eBay card (client-only)
        const formatSel   = body.querySelector("#ebay_formatSelect");
        const bestOffer   = body.querySelector("#ebay_bestOffer");
        const promoteChk  = body.querySelector("#ebay_promote");

        const fixedOnly     = () => body.querySelectorAll(".ebay-fixed-only");
        const auctionOnly   = () => body.querySelectorAll(".ebay-auction-only");
        const bestOfferOnly = () => body.querySelectorAll(".ebay-bestoffer-only");
        const promoOnly     = () => body.querySelectorAll(".ebay-promote-only");

        function applyEbayVisibility() {
          const fmt = (formatSel?.value || "").toLowerCase(); // "" | "fixed" | "auction"
          const isFixed   = fmt === "fixed";
          const isAuction = fmt === "auction";
          const hasBO     = !!bestOffer?.checked;
          const promo     = !!promoteChk?.checked;

          fixedOnly().forEach(n => n.classList.toggle("hidden", !isFixed));
          auctionOnly().forEach(n => n.classList.toggle("hidden", !isAuction));
          bestOfferOnly().forEach(n => n.classList.toggle("hidden", !(isFixed && hasBO)));
          promoOnly().forEach(n => n.classList.toggle("hidden", !promo));

          // When Best Offer is unchecked, clear and mark not required
          const autoAcc = body.querySelector("#ebay_autoAccept");
          const minOff  = body.querySelector("#ebay_minOffer");
          if (autoAcc) autoAcc.required = isFixed && hasBO;
          if (minOff)  minOff.required  = isFixed && hasBO;

          // Re-evaluate button enablement whenever fields become shown/hidden or required flips
          try { computeValidity(); } catch {}
        }

        // Any change that can flip visibility/required should re-run validity
        formatSel?.addEventListener("change", applyEbayVisibility);
        bestOffer?.addEventListener("change", applyEbayVisibility);
        promoteChk?.addEventListener("change", applyEbayVisibility);

        // First paint: align UI *and* button states to current values
        applyEbayVisibility();
        try { computeValidity(); } catch {}
      } else {
        // Generic placeholder card for other marketplaces (no filler lists yet)
        body.innerHTML = `
          <div class="muted text-sm">Marketplace-specific fields coming soon.</div>
        `;
        card.appendChild(body);
      }

      return card;
    }

    // For each selected marketplace, ensure a card exists
    for (const id of desiredIds) {
      if (realized.has(id)) continue; // delta mode: keep existing card and its values
      const m = byId.get(Number(id));
      if (!m) continue;
      const card = createMarketplaceCard(m, prevStatuses.get(Number(id)));
      host.appendChild(card);
    }

    // After rendering marketplace cards, sync the FB status once
    try { refreshFacebookTile(); } catch {}

    // If no marketplaces selected, nothing renders here by design.
  }


  // === END NEW ===

  // ===== Marketplace Status UI helpers (Facebook) =====
  function getFacebookStatusNodes() {
    const card = Array.from(document.querySelectorAll('#marketplaceCards .card'))
      .find(c => /facebook/i.test((c.querySelector('.font-semibold')?.textContent || '')));
    if (!card) return { textEl: null, wrap: null };
    const wrap = card.querySelector('[data-card-status]') || card;
    const textEl = card.querySelector('[data-status-text]') || wrap.querySelector('.mono') || wrap;
    return { textEl, wrap };
  }

  function setFacebookStatus(label, { link = null, tone = 'muted' } = {}) {
    const { textEl, wrap } = getFacebookStatusNodes();
    if (!textEl) return;
    const classes = ['text-gray-600','text-blue-700','text-green-700','text-red-700'];
    try { wrap.classList.remove(...classes); } catch {}
    if (tone === 'info')  wrap.classList.add('text-blue-700');
    if (tone === 'ok')    wrap.classList.add('text-green-700');
    if (tone === 'error') wrap.classList.add('text-red-700');
    if (link) {
      textEl.innerHTML = '';
      const a = document.createElement('a');
      a.href = link; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = label;
      textEl.appendChild(a);
    } else {
      textEl.textContent = label;
    }
  }

 async function refreshFacebookTile() {
  try {
    if (!__currentItemId) return;

    const snap = await api(
      `/api/inventory/intake?item_id=${encodeURIComponent(__currentItemId)}`,
      { method: "GET" }
    );

    // Be tolerant to server response shapes:
    // - marketplace_listing vs marketplace_listings
    // - keyed by slug ("facebook") OR marketplace_id (2)
    const mp = snap?.marketplace_listing || snap?.marketplace_listings || {};
    const fbRow =
      mp?.facebook ??
      mp?.Facebook ??
      mp?.["2"] ??
      null;

    const rawStatus =
      fbRow?.status ??
      fbRow?.listing_status ??
      fbRow?.state ??
      "";

    const st = String(rawStatus).trim().toLowerCase();

    if (!st || st === "draft" || st === "not_listed") {
      setFacebookStatus("Not Listed", { tone: "muted" });
      return;
    }

    if (st === "publishing" || st === "pending_external" || st === "processing") {
      setFacebookStatus("Publishing…", { tone: "info" });
      return;
    }

    if (st === "live" || st === "listed") {
      const url =
        fbRow?.mp_item_url ??
        fbRow?.remote_url ??
        fbRow?.url ??
        null;
      setFacebookStatus("Listed", { tone: "ok", link: url || null });
      return;
    }

    if (st === "error" || st === "create_failed" || st === "failed") {
      const msg = (fbRow?.last_error ? String(fbRow.last_error).slice(0, 120) : "");
      setFacebookStatus(msg ? `Error — ${msg}` : "Error", { tone: "error" });
      return;
    }

    setFacebookStatus("Unknown", { tone: "muted" });
  } catch (e) {
    console.warn("[intake.js] refreshFacebookTile failed", e);
  }
}

  
  // ===== Marketplace Status UI helpers (eBay) =====
  function getEbayStatusNodes() {
    // Find the eBay card and its status span
    const card = Array.from(document.querySelectorAll('#marketplaceCards .card'))
      .find(c => /ebay/i.test((c.querySelector('.font-semibold')?.textContent || '')));
    if (!card) return { textEl: null, wrap: null };
  
    const wrap = card.querySelector('[data-card-status]') || card;
    const textEl = card.querySelector('[data-status-text]') || wrap.querySelector('.mono') || wrap;
    return { textEl, wrap };
  }
  
  function setEbayStatus(label, { link = null, tone = 'muted' } = {}) {
    const { textEl, wrap } = getEbayStatusNodes();
    if (!textEl) return;
  
    // Color cue via utility classes
    const classes = ['text-gray-600','text-blue-700','text-green-700','text-red-700'];
    wrap.classList.remove(...classes);  
    if (tone === 'info')  wrap.classList.add('text-blue-700');
    if (tone === 'ok')    wrap.classList.add('text-green-700');
    if (tone === 'error') wrap.classList.add('text-red-700');
  
    // Set text/anchor
    if (link) {
      textEl.innerHTML = ''; // clear
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = label;
      textEl.appendChild(a);
    } else {
      textEl.textContent = label;
    }
  }

    async function trackPublishJob(jobId, { maxMs = 90000, intervalMs = 1500 } = {}) {
        const started = Date.now();
      
        async function pollOnce() {
          try {
            // Poll the existing POST endpoint. Your server returns { ok, status, remote? } when terminal.
            const res = await fetch(`/api/marketplaces/publish/run?job_id=${encodeURIComponent(jobId)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ poll: true })
            });
            const body = await res.json().catch(() => ({}));
      
            const status = String(body?.status || body?.state || "").toLowerCase();
      
            if (status === "succeeded") {
              const remote = body.remote || {};
              const url = remote.remoteUrl || remote.remoteURL || null;
              setEbayStatus("Listed", { tone: "ok", link: url || null });
              return true;
            }
      
            if (status === "failed" || status === "dead" || body?.error) {
              const msg = String(body?.error || "Failed").slice(0, 160);
              setEbayStatus(`Error${msg ? ` — ${msg}` : ""}`, { tone: "error" });
              return true;
            }
      
            // Non-terminal shapes your server returns while work is ongoing
            // Examples you've seen: { ok: true, taken: 0 }
            
            // --- Fallback guard ---
            // If the job API hasn't reported "succeeded" yet, check the persisted listing row.
            // We already hydrate the screen with GET /api/inventory/intake when loading drafts;
            // use the same contract here so we don't spin forever if the job ended but the
            // job endpoint didn't deliver a terminal payload to this browser.
            try {
              if (__currentItemId) {
                const snap = await api(`/api/inventory/intake?item_id=${encodeURIComponent(__currentItemId)}`, { method: "GET" });
                const live = String(snap?.marketplace_listing?.ebay?.status || "").toLowerCase() === "live";
                if (live) {
                  const url = snap?.marketplace_listing?.ebay?.mp_item_url || null;
                  setEbayStatus("Listed", { tone: "ok", link: url || null });
                  return true; // break the loop
                }
              }
            } catch { /* ignore and keep polling until timeout */ }
            
            return false;
          } catch {
            // Network hiccup — keep polling until timeout
            return false;
          }
        }
      
        let done = await pollOnce();
          while (!done && (Date.now() - started) < maxMs) {
            await new Promise(r => setTimeout(r, intervalMs));
            done = await pollOnce();
          }
        
          if (!done) setEbayStatus("Unknown", { tone: "muted" });
        }
  
       
        function computeValidity() {
          // BASIC — always required (explicit control list)
          const basicControls = getBasicRequiredControls();
          const basicOk = markBatchValidity(basicControls, hasValue);
      
          // PHOTOS — must have at least one (persisted or pending)
          const photoCount = (__photos?.length || 0) + (__pendingFiles?.length || 0);
          const photosOk = photoCount >= 1;
          // Light accessibility cue on the Photos card/header when missing
          (function markPhotos(ok) {
            const host = document.getElementById("photosCard")
                     || document.getElementById("photosGrid")
                     || document.getElementById("photosCount");
            if (host) host.setAttribute("aria-invalid", ok ? "false" : "true");
          })(photosOk);
      
          
          // MARKETPLACE — required only when active
          let marketOk = true;
          if (marketplaceActive()) {
            const marketControls = getMarketplaceRequiredControls();
            marketOk = markBatchValidity(marketControls, hasValue);
      
            // Require ≥1 selected marketplace tile when marketplace flow is active
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
      
          // ⬅️ photos are part of the gate
          const allOk = basicOk && photosOk && marketOk;
          setCtasEnabled(allOk);
          document.dispatchEvent(new CustomEvent("intake:validity-changed", { detail: { valid: allOk } }));
          return allOk;
        }

        // --- Copy for Xeasy: helpers & click handler (anchored insert) ---
        function enableCopyXeasy(enabled = true) {
          const btn = document.getElementById("copyXeasyBtn");
          if (!btn) return;
          btn.disabled = !enabled;
          btn.classList.toggle("opacity-60", !enabled);
          btn.classList.toggle("cursor-not-allowed", !enabled);
          btn.title = enabled ? "Copy for Xeasy" : "Enabled in Phase 2";
        }
        
        function buildXeasyText() {
        // Title
        const titleEl = document.getElementById("titleInput") || findControlByLabel("Item Name / Description");
        const title = String(titleEl?.value || "").trim();
      
        // Price → format with a leading $; integers show as $10, non-integers as $10.50
        const priceCtrl = document.getElementById("priceInput") || findControlByLabel("Price (USD)");
        const rawPrice = String(priceCtrl?.value ?? "").trim();
        let price = rawPrice;
        if (price) {
          const n = Number(String(price).replace(/[$,]/g, ""));
          if (!Number.isNaN(n)) {
            price = Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
          } else if (!price.startsWith("$")) {
            price = `$${price}`;
          }
        }
      
        // SKU priority: server snapshot → [data-sku-out] / #skuOut → __lastKnownSku
        let sku = "";
        try {
          const snapSku = String(window?.__intakeSnap?.inventory?.sku ?? "").trim();
          if (snapSku) sku = snapSku;
        } catch {}
        if (!sku) {
          try {
            const el = document.querySelector("[data-sku-out]") || document.getElementById("skuOut");
            if (el) {
              const t = String(el.textContent || "");
              const m = t.match(/SKU\s*(.+)$/i); // handles "SKU ABC-12345"
              sku = (m ? m[1] : t).trim();
            }
          } catch {}
        }
        if (!sku) {
          try { sku = String(window.__lastKnownSku || "").trim(); } catch {}
        }
      
        // Store location & Case # (prefer the combined label "Case#/Bin#/Shelf#" if present)
        const storeSel = document.getElementById("storeLocationSelect");
        const storeLoc = String(storeSel?.value || "").trim();
        const caseEl =
          document.getElementById("caseShelfInput")
          || findControlByLabel("Case#/Bin#/Shelf#")
          || findControlByLabel("Case #");
        const caseNo = String(caseEl?.value || "").trim();
      
        // Word-safe packing: first 14 chars (no mid-word) then next 23 chars (no mid-word)
        const packWords = (s, limit) => {
          const words = String(s || "").trim().split(/\s+/).filter(Boolean);
          if (words.length === 0) return ["", ""];
          let part = "";
          let i = 0;
          while (i < words.length) {
            const next = part ? `${part} ${words[i]}` : words[i];
            if (next.length <= limit) {
              part = next;
              i++;
            } else {
              break;
            }
          }
          if (!part) { // if first word itself > limit, take it whole (no truncation)
            part = words[0];
            i = 1;
          }
          const rest = words.slice(i).join(" ");
          return [part, rest];
        };
      
        // Line 1: Price and SKU
        const line1 = `${price} ${sku}`.trim();
      
        // Line 2/3: prepend RC, then title split across 14/23 without breaking words
        const rc = `R${storeLoc}-C${caseNo}`.trim();
        const [t1, tail] = packWords(title, 14);
        const [t2] = packWords(tail, 23);
      
        const line2 = `${rc} ${t1}`.trim();
        const line3 = String(t2 || "").trim();
      
        return [line1, line2, line3].filter(Boolean).join("\n");
      }

        
        function wireCopyXeasy() {
          const btn = document.getElementById("copyXeasyBtn");
          if (!btn) return;
          btn.addEventListener("click", async (e) => {
            e.preventDefault();
            try {
              const text = buildXeasyText();
              await navigator.clipboard.writeText(text);
              if (typeof window.uiToast === "function") {
                window.uiToast("Copied for Xeasy.");
              } else {
                alert("Copied for Xeasy.");
              }
            } catch (err) {
              console.error("copy:xeasy:error", err);
              alert("Failed to copy Xeasy text.");
            }
          });
        }
        // --- end Copy for Xeasy insert ---
      
        /* === Facebook handoff helpers (NEW) === */

        // Build the payload the Tampermonkey script will send to Facebook.
        window.rpBuildFacebookPayload = function rpBuildFacebookPayload() {

          // 0) Resolve tenant (stashed during init) with robust fallbacks
          const tenant_id = 
            (typeof window.__tenantId === "string" && window.__tenantId) ||
            (typeof window.ACTIVE_TENANT_ID === "string" && window.ACTIVE_TENANT_ID) ||
            (document.querySelector('meta[name="x-tenant-id"]')?.getAttribute?.("content") || "") ||
            (document.documentElement.getAttribute("data-tenant-id") || "") ||
            (localStorage.getItem("rp:tenant_id") || "");
          
          // 1) title / price / qty
          const titleEl = document.getElementById("titleInput") || findControlByLabel("Item Name / Description");
          const priceEl = document.getElementById("priceInput") || findControlByLabel("Price (USD)");
          const qtyEl   = document.getElementById("qtyInput")   || findControlByLabel("Qty");
          
          const title = String(titleEl?.value || "").trim();
          const price = Number(priceEl?.value || 0) || 0;
          const qty   = Math.max(0, parseInt(qtyEl?.value || "0", 10) || 0);

          // 2) Prefer the server snapshot’s composed description (cached by __emitFacebookReadyIfSafe)
          let composed = "";
          try {
            const snap = (window && window.__intakeSnap) || null;
            const fromDb = String(snap?.item_listing_profile?.product_description || "");
            if (fromDb) composed = fromDb;
          } catch { /* fallback below */ }
        
          // 2b) Fallback: reconstruct locally to match server rules if needed
          if (!composed) {
            const BASE_SENTENCE =
              "The photos are part of the description. Be sure to look them over for condition and details. This is sold as is, and it's ready for a new home.";
          
            const ensureBaseOnce = (t) => {
              const v = String(t || "").trim();
              if (!v) return BASE_SENTENCE;
              return v.includes(BASE_SENTENCE) ? v : `${BASE_SENTENCE}${v ? "\n\n" + v : ""}`;
            };
          
            const descEl = document.getElementById("longDescriptionTextarea") || findControlByLabel("Long Description");
            const raw = String(descEl?.value || "").trim();
            let body = ensureBaseOnce(raw);
            if (title && !body.startsWith(title)) body = `${title}\n\n${body}`;
          
            // Footer from cached snapshot or visible fields
            const snap = (window && window.__intakeSnap) || null;
            const sku = String((snap?.inventory?.sku ?? window.__lastKnownSku ?? "") || "").trim();
            const loc = String((snap?.inventory?.instore_loc ?? findControlByLabel("Store Location")?.value ?? "") || "").trim();
            const cbs = String((snap?.inventory?.case_bin_shelf ?? findControlByLabel("Case#/Bin#/Shelf#")?.value ?? "") || "").trim();
          
            if (sku) {
              const footerLine = `SKU: ${sku} • Location: ${loc || "—"} • Case/Bin/Shelf: ${cbs || "—"}`;
              body = `${body}\n\n${footerLine}`;
            }
            composed = body;
          }
        
          // 3) append store footer lines (Facebook-specific)
          let description = composed;
          const footer =
            "Mad Rad Retro Toys\n" +
            "5026 Kipling Street\n" +
            "Wheat Ridge, CO 80033\n" +
            "MON-SAT 10-5\n" +
            "SUN 11-5\n" +
            "303-960-2117";
          description = description ? `${description}\n\n${footer}` : footer;
        
          // 4) hard-coded for v1
          const category  = "Action Figures";
          const condition = "Used - Good";
          const availability = qty > 1 ? "List as in Stock" : "List as Single Item";
        
          // 5) images from state (__photos), ordered: primary first, then sort_order
          const ordered = (__photos || [])
            .slice()
            .sort((a, b) => {
              const pa = a.is_primary ? -1 : 0;
              const pb = b.is_primary ? -1 : 0;
              if (pa !== pb) return pa - pb;
              return (a.sort_order ?? 0) - (b.sort_order ?? 0);
            })
            .map(x => String(x.cdn_url || ""))
            .filter(Boolean);
        
          // Resolve SKU from the server snapshot first; fall back to any visible UI echo.
          const sku = (() => {
            try {
              const snap = (window && window.__intakeSnap) || null;
              const v = snap?.inventory?.sku;
              if (v) return String(v).trim();
            } catch {}
            const out = document.querySelector("[data-sku-out]")?.textContent;
            if (out) return String(out).trim();
            return String(window.__lastKnownSku || "").trim();
          })();
          
          const payload = {
            tenant_id, title, price, qty, availability, category, condition, description,
            sku, // <-- added
            images: ordered,
            item_id: __currentItemId || null,
            created_at: Date.now()
          };
        
          // ✅ FULL payload log for debugging
          try {
            console.log("[intake.js] facebook payload", JSON.parse(JSON.stringify(payload)));
          } catch {
            console.log("[intake.js] facebook payload", payload);
          }
        
          return payload;
        }; // <-- end rpBuildFacebookPayload (removed the extra closing brace)

        
        // Only fire when: Active save, photos flushed, all publish jobs are settled,
        // AND the Facebook tile is selected, AND the Facebook listing is not already live.
        async function __emitFacebookReadyIfSafe({ saveStatus, jobIds }) {
          console.groupCollapsed("[intake.js] facebook:gate");
          console.log("preconditions", {
            saveStatus,
            pendingFiles: (__pendingFiles && __pendingFiles.length) || 0,
            jobIdsCount: Array.isArray(jobIds) ? jobIds.length : 0
          });
        
          if (String(saveStatus || "").toLowerCase() !== "active") {
            console.log("skip: saveStatus is not 'active'");
            console.groupEnd?.();
            return;
          }
        
          // photos flushed?
          if (__pendingFiles && __pendingFiles.length > 0) {
            console.log("skip: pending photos not flushed yet");
            console.groupEnd?.();
            return;
          }
        
          // runner quiet?
          if (Array.isArray(jobIds) && jobIds.length > 0) {
            const anyRunning = document.querySelector('[data-status-text]')?.textContent?.match(/Publishing|Deleting/i);
            if (anyRunning) {
              console.log("skip: publish runner still active");
              console.groupEnd?.();
              return;
            }
          }
        
          // is Facebook selected?
          const isFacebookSelected = (() => {
            // use the cached meta to map selected ids → slug
            const rows = (__metaCache?.marketplaces || []);
            const byId = new Map(rows.map(r => [Number(r.id), String(r.slug || "").toLowerCase()]));
            for (const id of selectedMarketplaceIds) {
              if (byId.get(Number(id)) === "facebook") return true;
            }
            return false;
          })();
          if (!isFacebookSelected) {
            console.log("skip: Facebook tile not selected");
            console.groupEnd?.();
            return;
          }
        
          // not already live?
          if (__currentItemId) {
            try {
              const snap = await api(`/api/inventory/intake?item_id=${encodeURIComponent(__currentItemId)}`, { method: "GET" });
              // cache the full snapshot so rpBuildFacebookPayload can read description synchronously
              window.__intakeSnap = snap;
              // keep a last-known SKU around for local fallback builders
              try { window.__lastKnownSku = String(snap?.inventory?.sku || ""); } catch {}
              const live = String(snap?.marketplace_listing?.facebook?.status || "").toLowerCase() === "live";
              console.log("existing fb status", { live, status: snap?.marketplace_listing?.facebook?.status });
              if (live) { console.log("skip: already live"); console.groupEnd?.(); return; }
            } catch (e) {
              console.warn("fb status check failed", e);
            }
          }
        
          const payload = window.rpBuildFacebookPayload();
            console.log("dispatch intake:facebook-ready", {
              item_id: __currentItemId || null,
              title: payload?.title,
              images: (payload?.images || []).length
            });
            document.dispatchEvent(new CustomEvent("intake:facebook-ready", {
              detail: { item_id: __currentItemId || null, payload }
            }));
            console.groupEnd?.();
          }
      
          document.addEventListener("intake:facebook-ready", (ev) => {
            const __t0 = performance.now();
            const payload =
              ev?.detail?.payload ||
              (typeof window.rpBuildFacebookPayload === "function" ? window.rpBuildFacebookPayload() : null);
            if (!payload) return;
          
              console.groupCollapsed("[intake.js] facebook:intake → begin");
              setFacebookStatus("Publishing…", { tone: "info" });
              console.log("[intake.js] payload echo", payload);   // keep an echo here too
              // Kick a short, one-time poll while the FB tab runs (max ~15s)
              (function pollForFlipOnce() {
                let ticks = 0;
                const t = setInterval(async () => {
                  try { await refreshFacebookTile(); } catch {}
                  if (++ticks >= 15) clearInterval(t);
                }, 1000);
              })();
            // 1) Same-origin handoff for Tampermonkey cache
            try {
              window.postMessage({ type: "RP_FACEBOOK_CREATE", payload }, location.origin);
              console.log("[intake.js] postMessage → same-origin (RP_FACEBOOK_CREATE cached)");
            } catch (e) {
              console.warn("[intake.js] failed to send RP_FACEBOOK_CREATE", e);
            }

            // 2) Window handling — prefer the user-gesture stub, otherwise open now
            let fbWin = window.__rpFbWin || null;
            const FB_URL = "https://www.facebook.com/marketplace/create/item";
            console.log("[intake.js] fbWin.stub", { hasStub: !!fbWin, closed: !!fbWin?.closed });
  
            if (!fbWin || fbWin.closed) {
              // No stub available: try to open now (still may be blocked without a user gesture)
              fbWin = window.open(FB_URL, "_blank", "popup=1");  // no 'noopener'
              const opened = !!fbWin && !fbWin.closed;
              console.log("[intake.js] open.fb →", { opened });
            
              if (!opened) {
                console.warn("[intake.js] popup blocked — allow popups for resellpros.com to auto-open Facebook.");
                if (typeof window.uiToast === "function") {
                  window.uiToast("Popup blocked — please allow popups for resellpros.com, then click Save again to open Facebook.");
                } else {
                  // fall back to non-blocking console notice instead of alert
                  console.log("Popup blocked — please allow popups for resellpros.com, then click Save again to open Facebook.");
                }
                console.groupEnd?.();
                return;
              }
            } else {
              // Reuse the stub we opened on the user click
              console.log("reuse.stubWindow → navigate", FB_URL);
              try { fbWin.location.href = FB_URL; } catch (e) { console.warn("nav to FB_URL failed", e); }
            }
  
            // 3) (Optional secondary path) also try direct cross-origin postMessage to facebook.com
            const post = () => {
              try {
                fbWin.postMessage({ source: "resellpro", type: "facebook:intake", payload }, "https://www.facebook.com");
                console.log("[intake.js] postMessage → facebook.com (queued)");
              } catch (e) {
                console.warn("[intake.js] postMessage failed (retrying)", e);
              }
            };
  
            console.log("[intake.js] post.start");
            post();
            const t = setInterval(post, 1000);
  
            setTimeout(() => {
              clearInterval(t);
              const __t1 = performance.now();
              console.log("[intake.js] facebook:intake → done", { ms: Math.round(__t1 - __t0) });
              console.groupEnd?.();
            }, 8000);
        });




/** Refresh when the FB tab signals it’s done (dry-run or real) */
window.addEventListener("message", (ev) => {
  try {
    const okOrigin =
      ev.origin === location.origin || ev.origin === "https://www.facebook.com";
    if (!okOrigin) return;
    if (ev.data && ev.data.type === "facebook:create:done") {
      refreshFacebookTile();
    }
  } catch {}
});

/** Also refresh when user returns focus from the FB window */
window.addEventListener("focus", () => {
  setTimeout(() => { try { refreshFacebookTile(); } catch {} }, 300);
});

  
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
  console.groupCollapsed("[intake.debug] refreshDrafts()", { force, tabVisible: isDraftsTabVisible() });
  try {
    if (!force && !isDraftsTabVisible()) { console.log("skip: drafts tab hidden"); return; }
    if (__draftsRefreshTimer) window.clearTimeout(__draftsRefreshTimer);
    __draftsRefreshTimer = window.setTimeout(async () => {
      const t0 = performance.now();
      try {
        const header = document.querySelector('#recentDraftsHeader, [data-recent-drafts-header]');
        if (header) header.classList.add("loading");
        const fn = (window && window.__loadDrafts) || (typeof loadDrafts === "function" ? loadDrafts : null);
        console.log("call loadDrafts()", { hasWrapper: !!window.__loadDrafts, found: !!fn });
        if (fn) { await fn(); }
        console.log("loadDrafts() done", { elapsed_ms: Math.round(performance.now() - t0) });
      } catch (e) {
        console.error("refreshDrafts.error", e);
      } finally {
        const header = document.querySelector('#recentDraftsHeader, [data-recent-drafts-header]');
        if (header) header.classList.remove("loading");
        __draftsRefreshTimer = null;
      }
    }, 300);
  } finally {
    console.groupEnd?.();
  }
}

// Central event to refresh Drafts after successful add/save/delete
document.addEventListener("intake:item-changed", () => refreshDrafts({ force: true }));
// --- end Drafts refresh bus ---

// --- Inventory refresh bus + helpers (NEW) ---
let __inventoryRefreshTimer = null;

function isInventoryTabVisible() {
  const pane = document.getElementById("paneInventory");
  if (!pane) return true;
  const hiddenByAttr = pane.getAttribute("hidden") != null;
  const hiddenByClass = pane.classList.contains("hidden");
  return !(hiddenByAttr || hiddenByClass);
}

async function refreshInventory({ force = false } = {}) {
  console.groupCollapsed("[intake.debug] refreshInventory()", { force, tabVisible: isInventoryTabVisible() });
  try {
    if (!force && !isInventoryTabVisible()) { console.log("skip: inventory pane hidden"); return; }
    if (__inventoryRefreshTimer) window.clearTimeout(__inventoryRefreshTimer);
    __inventoryRefreshTimer = window.setTimeout(async () => {
      const t0 = performance.now();
      try {
        const header = document.querySelector('#recentInventoryHeader, [data-recent-inventory-header]');
        if (header) header.classList.add("loading");
        const fn = (window && window.__loadInventory) || (typeof loadInventory === "function" ? loadInventory : null);
        console.log("call loadInventory()", { hasWrapper: !!window.__loadInventory, found: !!fn });
        if (fn) { await fn(); }
        console.log("loadInventory() done", { elapsed_ms: Math.round(performance.now() - t0) });
      } catch (e) {
        console.error("refreshInventory.error", e);
      } finally {
        const header = document.querySelector('#recentInventoryHeader, [data-recent-inventory-header]');
        if (header) header.classList.remove("loading");
        __inventoryRefreshTimer = null;
      }
    }, 300);
  } finally {
    console.groupEnd?.();
  }
}

// Refresh inventory after add/save/delete when the Inventory tab is open
document.addEventListener("intake:item-changed", () => refreshInventory({ force: true }));
// --- end Inventory refresh bus ---
  
  
  
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
    // …inside init() for the intake screen…
    const meta = await loadMeta();
    
    // Derive tenant_id once from the meta response; fall back to DOM or localStorage.
    // Store it in both our local stash and the global ACTIVE_TENANT_ID used by api().
    (function () {
      const fromMeta =
        (meta && (meta.tenant_id || (meta.tenant && (meta.tenant.tenant_id || meta.tenant.id)))) || "";
      const fromDom =
        document.documentElement.getAttribute("data-tenant-id") ||
        (function () {
          const m = document.querySelector('meta[name="x-tenant-id"]');
          return m ? m.getAttribute("content") : "";
        })() ||
        "";
      const fromStore = localStorage.getItem("rp:tenant_id") || "";
    
      const resolved = String((fromMeta || fromDom || fromStore || "")).trim();
    
      // write once for the page lifetime
      window.__tenantId = resolved;            // used by the multipart upload fetch
      window.ACTIVE_TENANT_ID = resolved;      // used by the centralized api() helper
    })();
    
    // (your existing code continues here…)

    try {
      __tenantId =
        String(
          (meta && (meta.tenant_id || meta?.tenant?.tenant_id || meta?.tenant?.id)) ||
          document.documentElement.getAttribute("data-tenant-id") ||
          localStorage.getItem("rp:tenant_id") ||
          ""
        );
    } catch { __tenantId = ""; }

    // Populate Category (+ show its code hint)
    fillSelect($("categorySelect"), meta.categories, {
      textKey: "category_name",
      valueKey: "category_name",
      extras: (row) => ({ code: row.category_code }),
    });
    wireCategoryCodeHint(meta);

    // Marketplace lists
    // Categories: already objects with keys
    fillSelect($("marketplaceCategorySelect"), meta?.marketplace?.categories || [], {
      textKey: "display_name",
      valueKey: "category_key",
      extras: (row) => ({ path: row.path || "" }),
    });
    wireMarketplaceCategoryPath();
    
    // Brands: accept array of strings OR array of objects
    {
      const raw = meta?.marketplace?.brands || [];
      const asObjects = raw.map(r =>
        (r && typeof r === "object")
          ? r
          : { brand_name: String(r ?? ""), brand_key: String(r ?? "") }
      );
      const haveKey = asObjects.length > 0 && !!asObjects[0]?.brand_key;
      fillSelect($("brandSelect"), asObjects, {
        textKey: "brand_name",
        valueKey: haveKey ? "brand_key" : "brand_name",
      });
    }
    
    // Conditions: accept array of strings OR array of objects
    {
      const raw = meta?.marketplace?.conditions || [];
      const asObjects = raw.map(r =>
        (r && typeof r === "object")
          ? r
          : { condition_name: String(r ?? ""), condition_key: String(r ?? "") }
      );
      const haveKey = asObjects.length > 0 && !!asObjects[0]?.condition_key;
      fillSelect($("conditionSelect"), asObjects, {
        textKey: "condition_name",
        valueKey: haveKey ? "condition_key" : "condition_name",
      });
    }
    
    // Colors: accept array of strings OR array of objects
    {
      const raw = meta?.marketplace?.colors || [];
      const asObjects = raw.map(r =>
        (r && typeof r === "object")
          ? r
          : { color_name: String(r ?? ""), color_key: String(r ?? "") }
      );
      const haveKey = asObjects.length > 0 && !!asObjects[0]?.color_key;
      fillSelect($("colorSelect"), asObjects, {
        textKey: "color_name",
        valueKey: haveKey ? "color_key" : "color_name",
      });
    }

    // Shipping
    fillSelect($("shippingBoxSelect"), meta.shipping_boxes, {
      textKey: "box_name",
      valueKey: "box_key",
    });
    wireShippingBoxAutofill(meta);

    //Render marketplace tiles (below Shipping)
    __metaCache = meta;

    // Seed selection from per-user defaults for brand NEW items.
    // When loading an existing item, we override this with applyMarketplaceSelectionForItem().
    try {
      const defaults = readDefaults();
      selectedMarketplaceIds.clear();
      if (Array.isArray(defaults)) {
        for (const raw of defaults) {
          const id = Number(raw);
          if (!Number.isNaN(id)) {
            selectedMarketplaceIds.add(id);
          }
        }
      }
    } catch {}

    renderMarketplaceTiles(meta);
    // Render placeholder cards for any preselected tiles (from defaults)
    try { renderMarketplaceCards(__metaCache); } catch {}
      // Ensure the Facebook card reflects whatever Neon already knows on first paint
      try { await refreshFacebookTile(); } catch {}
      // === Hydrate per-user marketplace defaults (eBay) ===
      async function hydrateUserDefaults() {
        try {
          const res = await api(`/api/inventory/user-defaults?marketplace=ebay`, { method: "GET" });
          if (!res || res.ok === false || !res.defaults) return;
          const d = res.defaults;
    
          // 1) Stash policy ids so the async policy loader can re-apply after options arrive.
          //    If options are already present, we apply immediately as well.
          try {
            window.__ebaySavedPolicies = {
              shipping_policy: d.shipping_policy ?? "",
              payment_policy:  d.payment_policy  ?? "",
              return_policy:   d.return_policy   ?? "",
            };
            const tryApply = (id, val) => {
              const el = document.getElementById(id);
              if (!el) return;
              // only set if the option list is populated
              if (el.options && el.options.length > 0 && val) el.value = String(val);
            };
            tryApply("ebay_shippingPolicy", d.shipping_policy);
            tryApply("ebay_paymentPolicy",  d.payment_policy);
            tryApply("ebay_returnPolicy",   d.return_policy);
          } catch {}
    
          // 2) Non-policy fields can be set directly.
          const zipEl = document.getElementById("ebay_shipZip");
          if (zipEl && d.shipping_zip) zipEl.value = d.shipping_zip;
    
          const fmtEl = document.getElementById("ebay_formatSelect");
          if (fmtEl && d.pricing_format) fmtEl.value = String(d.pricing_format);
    
          const bestEl = document.getElementById("ebay_bestOffer");
          if (bestEl && typeof d.allow_best_offer === "boolean") bestEl.checked = d.allow_best_offer;
    
          const promEl = document.getElementById("ebay_promote");
          if (promEl && typeof d.promote === "boolean") promEl.checked = d.promote;
    
          // 3) Re-apply visibility rules and any dependent logic
          try {
            document.getElementById("ebay_formatSelect")?.dispatchEvent(new Event("change"));
            document.getElementById("ebay_bestOffer")?.dispatchEvent(new Event("change"));
            document.getElementById("ebay_promote")?.dispatchEvent(new Event("change"));
          } catch {}
        } catch {}
      }
    
    // Hydrate after cards exist
    try { await hydrateUserDefaults(); } catch {}
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

    // Pre-fill the Long Description field if empty
    ensureDefaultLongDescription();

    // If we arrived here from a Duplicate action, hydrate from the stashed seed
      try {
        hydrateFromDuplicateSeed();
      } catch (e) {
        console.error("[intake.js] hydrateFromDuplicateSeed failed", e);
      }
    
    // Wire and run initial validation
    wireValidation();
    computeValidity();
    
    // Auto-load drafts into the Drafts tab on screen load (does not auto-switch the tab)
    console.groupCollapsed("[intake.debug] init → loadDrafts (first paint)");
    try {
      const t0 = performance.now();
      if (typeof loadDrafts === "function") {
        const out = await loadDrafts();
        console.log("loadDrafts() resolved", { type: typeof out });
      } else {
        console.log("loadDrafts() not found at init");
      }
      console.log("elapsed_ms", Math.round(performance.now() - t0));
    } catch (e) {
      console.error("loadDrafts.init.error", e);
    } finally {
      console.groupEnd?.();
    }
    
    // True tab wiring (ARIA tabs + lazy-load for Inventory)
    (function wireIntakeTabs() {
      const tabBulk       = document.getElementById("tabBulk");
      const tabDrafts     = document.getElementById("tabDrafts");
      const tabInventory  = document.getElementById("tabInventory");
      const paneBulk      = document.getElementById("paneBulk");
      const paneDrafts    = document.getElementById("paneDrafts");
      const paneInventory = document.getElementById("paneInventory");

      const tabs  = [tabDrafts, tabInventory, tabBulk].filter(Boolean);
      const panes = [paneDrafts, paneInventory, paneBulk].filter(Boolean);

      function setSelected(tabEl, isSelected) {
        if (!tabEl) return;
        tabEl.setAttribute("aria-selected", String(isSelected));
        tabEl.tabIndex = isSelected ? 0 : -1;

        // Visual affordance: make the selected tab look active/primary
        tabEl.classList.toggle("btn-primary", isSelected);
        tabEl.classList.toggle("btn-ghost", !isSelected);
      }

      function showPane(paneEl) {
        panes.forEach((p) => {
          if (!p) return;
          const active = p === paneEl;
          // Native hide
          p.hidden = !active;
          // Utility class (kept for visual parity with existing CSS)
          p.classList.toggle("hidden", !active);
          // ARIA state for assistive tech
          if (active) p.removeAttribute("aria-hidden");
          else p.setAttribute("aria-hidden", "true");
        });
      }

      function activate(tabEl, paneEl) {
        tabs.forEach((t) => setSelected(t, t === tabEl));
        showPane(paneEl);
        if (tabEl) tabEl.focus();
      }

      // Click behavior
      tabDrafts?.addEventListener("click", async (e) => {
        e.preventDefault();
        console.groupCollapsed("[intake.debug] CLICK → Drafts tab");
        try {
          activate(tabDrafts, paneDrafts);
          const t0 = performance.now();
          const fn = (typeof loadDrafts === "function") ? loadDrafts : null;
          console.log("activate(drafts) + call loadDrafts()", { found: !!fn });
          if (fn) { await fn(); }
          console.log("loadDrafts() completed", { elapsed_ms: Math.round(performance.now() - t0) });
        } catch (err) {
          console.error("tabDrafts.click.error", err);
        } finally {
          console.groupEnd?.();
        }
      });
      
      tabInventory?.addEventListener("click", async (e) => {
        e.preventDefault();
        console.groupCollapsed("[intake.debug] CLICK → Inventory tab");
        try {
          activate(tabInventory, paneInventory);
          const t0 = performance.now();
          const fn = (typeof loadInventory === "function") ? loadInventory : null;
          console.log("activate(inventory) + call loadInventory()", { found: !!fn });
          if (fn) { await fn(); }
          console.log("loadInventory() completed", { elapsed_ms: Math.round(performance.now() - t0) });
        } catch (err) {
          console.error("tabInventory.click.error", err);
        } finally {
          console.groupEnd?.();
        }
      });

      // Bulk is disabled/placeholder for now
      tabBulk?.addEventListener("click", () => {
        activate(tabBulk, paneBulk);
      });

      // Keyboard behavior (Left/Right/Home/End) for accessibility
      const KEY = { LEFT: 37, RIGHT: 39, HOME: 36, END: 35 };
      document.getElementById("intakeTabBar")?.addEventListener("keydown", (e) => {
        const current = document.activeElement;
        if (!tabs.includes(current)) return;

        let idx = tabs.indexOf(current);
        if (e.keyCode === KEY.LEFT)  { idx = (idx - 1 + tabs.length) % tabs.length; }
        if (e.keyCode === KEY.RIGHT) { idx = (idx + 1) % tabs.length; }
        if (e.keyCode === KEY.HOME)  { idx = 0; }
        if (e.keyCode === KEY.END)   { idx = tabs.length - 1; }

        if (idx !== -1 && tabs[idx]) {
          e.preventDefault();
          tabs[idx].click();
        }
      });

      // Default: Drafts selected, Inventory hidden
      activate(tabDrafts, paneDrafts);
    })();

    // [intake.debug] Targeted fetch logger for /api/inventory/{drafts|recent}
    (function rpInstrumentFetchOnce() {
      try {
        const g = window;
        if (!g || !g.fetch || g.fetch.__rpInventoryWrapped) return;
        const orig = g.fetch.bind(g);
        g.fetch = async function(input, init) {
          const url = (typeof input === "string") ? input : (input && input.url) || "";
          const isDrafts = /\/api\/inventory\/drafts?/i.test(url);
          const isRecent = /\/api\/inventory\/recent/i.test(url);
          const watch = isDrafts || isRecent;
    
          if (!watch) return orig(input, init);
    
          const t0 = performance.now();
          console.groupCollapsed("[intake.debug] fetch →", url);
          try {
            console.log("request", { method: (init && init.method) || "GET", headers: (init && init.headers) || undefined });
            const res = await orig(input, init);
            console.log("response", { status: res.status, ok: res.ok, type: res.type });
            try {
              const clone = res.clone();
              const text = await clone.text();
              let rows = null, ok = null, parsed = null;
              try { parsed = JSON.parse(text); } catch {}
              if (parsed && parsed.rows) rows = Array.isArray(parsed.rows) ? parsed.rows.length : null;
              if (parsed && typeof parsed.ok !== "undefined") ok = parsed.ok;
              console.log("body.peek", { ok, rows, bytes: text.length });
            } catch (e) {
              console.warn("peek.body.failed", String(e));
            }
            return res;
          } catch (err) {
            console.error("fetch.error", err);
            throw err;
          } finally {
            console.log("elapsed_ms", Math.round(performance.now() - t0));
            console.groupEnd?.();
          }
        };
        g.fetch.__rpInventoryWrapped = true;
      } catch (e) {
        console.warn("rpInstrumentFetchOnce.failed", e);
      }
    })();
    
    // --- [NEW] Submission wiring: both buttons call POST /api/inventory/intake ---
    function valByIdOrLabel(id, label) {
      const el = id ? document.getElementById(id) : null;
      if (el) return el.value ?? "";
      const byLbl = findControlByLabel(label || "");
      return byLbl ? (byLbl.value ?? "") : "";
    }

    // NEW: Collect eBay-specific marketplace listing fields and coerce types.
    // Maps directly to app.item_marketplace_listing columns.
    function getEbayListingFields() {
      const fmt = (document.getElementById("ebay_formatSelect")?.value || "").toLowerCase(); // "fixed" | "auction" | ""
      const isFixed   = fmt === "fixed";
      const isAuction = fmt === "auction";

      // raw values
      const shipping_policy = document.getElementById("ebay_shippingPolicy")?.value || "";
      const payment_policy  = document.getElementById("ebay_paymentPolicy")?.value || "";
      const return_policy   = document.getElementById("ebay_returnPolicy")?.value || "";
      const shipping_zip    = document.getElementById("ebay_shipZip")?.value || "";
      const pricing_format  = fmt || "";

      // numbers (coerce only if non-empty)
      const num = (id) => {
        const v = document.getElementById(id)?.value ?? "";
        return String(v).trim() === "" ? undefined : Number(v);
      };

      const buy_it_now_price   = num("ebay_bin");
      const starting_bid       = num("ebay_start");
      const reserve_price      = num("ebay_reserve");
      const promote_percent    = num("ebay_promotePct");
      const auto_accept_amount = num("ebay_autoAccept");
      const minimum_offer_amount = num("ebay_minOffer");

      // booleans
      const allow_best_offer = !!document.getElementById("ebay_bestOffer")?.checked;
      const promote          = !!document.getElementById("ebay_promote")?.checked;

      // “Duration” (present in UI); DB column may not exist yet — send anyway so backend can adopt later.
      const duration = document.getElementById("ebay_duration")?.value || "";

      // prune helper (drop empty strings/undefined/null)
      const prune = (obj) => {
        const out = {};
        for (const [k, v] of Object.entries(obj || {})) {
          if (v === null || v === undefined) continue;
          if (typeof v === "string" && v.trim() === "") continue;
          out[k] = v;
        }
        return out;
      };

      // Respect Fixed vs Auction visibility rules
      const base = {
        shipping_policy,
        payment_policy,
        return_policy,
        shipping_zip,
        pricing_format,
        buy_it_now_price,
        allow_best_offer: isFixed ? allow_best_offer : undefined,
        auto_accept_amount: isFixed && allow_best_offer ? auto_accept_amount : undefined,
        minimum_offer_amount: isFixed && allow_best_offer ? minimum_offer_amount : undefined,
        promote,
        promote_percent: promote ? promote_percent : undefined,
      };

      const auctionExtras = isAuction ? {
        duration,
        starting_bid,
        reserve_price,
      } : {};

              return prune({ ...base, ...auctionExtras });
        }
    
        function hydrateEbayFromSaved(ebay, ebayMarketplaceId) {
          if (!ebay) return;
        
          // Stash saved policy ids globally so the policy-loader can re-apply AFTER options arrive
          try {
            window.__ebaySavedPolicies = {
              shipping_policy: ebay.shipping_policy ?? "",
              payment_policy:  ebay.payment_policy  ?? "",
              return_policy:   ebay.return_policy   ?? ""
            };
          } catch {}
        
          // Reflect persisted listing status on the card
          // app.item_marketplace_listing(status, mp_item_url) -> ebay.status, ebay.mp_item_url
          // Map: live -> "Listed" (green, linkable); publishing -> "Publishing…"; error -> "Error"; else -> "Not Listed"
          try {
            const raw = String(ebay.status || "").toLowerCase();
            const url = ebay.mp_item_url || null;
            if (raw === "live") {
              setEbayStatus("Listed", { tone: "ok", link: url || null });
            } else if (raw === "publishing" || raw === "processing") {
              setEbayStatus("Publishing…", { tone: "info" });
            } else if (raw === "error" || raw === "failed" || raw === "dead") {
              setEbayStatus("Error", { tone: "error" });
            } else {
              setEbayStatus("Not Listed", { tone: "muted" });
            }
          } catch {}
        
          // Now set values inside the eBay card
          const setVal = (sel, v) => { if (sel) sel.value = v ?? ""; };
          const setNum = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.value = (v ?? "") === "" ? "" : String(v);
          };
          const setChk = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!v;
          };
    
          // Policies: attempt immediate set (may be overridden by async loader; Patch 1 will re-apply)
          setVal(document.getElementById("ebay_shippingPolicy"), ebay.shipping_policy);
          setVal(document.getElementById("ebay_paymentPolicy"),  ebay.payment_policy);
          setVal(document.getElementById("ebay_returnPolicy"),   ebay.return_policy);

          setVal(document.getElementById("ebay_shipZip"),        ebay.shipping_zip);
    
          setVal(document.getElementById("ebay_formatSelect"),   ebay.pricing_format);
          setVal(document.getElementById("ebay_duration"),       ebay.duration);
    
          setNum("ebay_bin",       ebay.buy_it_now_price);
          setNum("ebay_start",     ebay.starting_bid);
          setNum("ebay_reserve",   ebay.reserve_price);
          setChk("ebay_bestOffer", ebay.allow_best_offer);
    
          setNum("ebay_autoAccept", ebay.auto_accept_amount);
          setNum("ebay_minOffer",   ebay.minimum_offer_amount);
    
          setChk("ebay_promote",    ebay.promote);
          setNum("ebay_promotePct", ebay.promote_percent);
    
          // Re-apply eBay visibility rules so hidden/required states match values
          try {
            const fmt = document.getElementById("ebay_formatSelect");
            const bo  = document.getElementById("ebay_bestOffer");
            const pr  = document.getElementById("ebay_promote");
            fmt?.dispatchEvent(new Event("change"));
            bo?.dispatchEvent(new Event("change"));
            pr?.dispatchEvent(new Event("change"));
          } catch {}
    
          // Also re-validate the whole form
          try { computeValidity(); } catch {}
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
        listing_category_key: valByIdOrLabel("marketplaceCategorySelect", "Marketplace Category"),
        condition_key:        valByIdOrLabel("conditionSelect", "Condition"),
        brand_key:            valByIdOrLabel("brandSelect", "Brand"),
        color_key:            valByIdOrLabel("colorSelect", "Primary Color"),
        product_description:  valByIdOrLabel(null, "Long Description"),
        shipping_box_key:     valByIdOrLabel("shippingBoxSelect", "Shipping Box"),
        weight_lb:  (() => { const v = valByIdOrLabel("shipWeightLb", "Weight (lb)"); return v !== "" ? Number(v) : undefined; })(),
        weight_oz:  (() => { const v = valByIdOrLabel("shipWeightOz", "Weight (oz)"); return v !== "" ? Number(v) : undefined; })(),
        shipbx_length: (() => { const v = valByIdOrLabel("shipLength", "Length"); return v !== "" ? Number(v) : undefined; })(),
        shipbx_width:  (() => { const v = valByIdOrLabel("shipWidth", "Width"); return v !== "" ? Number(v) : undefined; })(),
        shipbx_height: (() => { const v = valByIdOrLabel("shipHeight", "Height"); return v !== "" ? Number(v) : undefined; })(),
      };

      // NEW: eBay marketplace listing fields (maps to app.item_marketplace_listing)
      const ebayListing = getEbayListingFields();

      if (isDraft) {
        // Send any non-empty fields for drafts (Basic + Marketplace + eBay listing fields)
        const inventory = prune(invAll);
        const listing   = prune(listingAll);
        const payload = { status: "draft", inventory };
      
        if (Object.keys(listing).length > 0) payload.listing = listing;

        // Ensure marketplaces_selected includes the UI selections (including Facebook)
        try {
          // Reuse whatever mechanism you already have for tile selection; fallback to data-attributes
          const selected = new Set(Array.from(document.querySelectorAll('[data-mp-selected="true"]')).map(n => (n.dataset.mpSlug || "").toLowerCase()));
          // If you store selected IDs elsewhere, merge them here
          if (!Array.isArray(payload.marketplaces_selected)) payload.marketplaces_selected = [];
          for (const s of selected) {
            if (s && !payload.marketplaces_selected.includes(s)) payload.marketplaces_selected.push(s);
          }
        } catch { /* no-op */ }
        
        // eBay-specific fields (existing)
        if (Object.keys(ebayListing).length > 0) {
          payload.marketplace_listing = { ...(payload.marketplace_listing || {}), ebay: ebayListing };
        }

        // NEW: Facebook flag so the server upserts the stub row
        if (payload.marketplaces_selected.includes("facebook")) {
          payload.marketplace_listing = { ...(payload.marketplace_listing || {}), facebook: {} };
        }

          // If this is a duplicated brand-new item, send source images for server-side copy
          if (
            !__currentItemId &&
            Array.isArray(__duplicateSourceImages) &&
            __duplicateSourceImages.length > 0
          ) {
            payload.duplicate_images = __duplicateSourceImages.map((img, idx) => ({
              r2_key: img.r2_key,
              cdn_url: img.cdn_url,
              bytes: img.bytes,
              content_type: img.content_type,
              width: img.width ?? null,
              height: img.height ?? null,
              sha256: img.sha256 ?? null,
              sort_order: typeof img.sort_order === "number" ? img.sort_order : idx,
              is_primary: !!img.is_primary,
            }));
          }

          return payload;
       }

    
      // Active/new items
      const salesChannel = valByIdOrLabel("salesChannelSelect", "Sales Channel");
      const isStoreOnly = /store only/i.test(String(salesChannel || ""));
      const inventory = prune(invAll);
    
      if (isStoreOnly) {
        const payload = { inventory };

        if (
          !__currentItemId &&
          Array.isArray(__duplicateSourceImages) &&
          __duplicateSourceImages.length > 0
        ) {
          payload.duplicate_images = __duplicateSourceImages.map((img, idx) => ({
            r2_key: img.r2_key,
            cdn_url: img.cdn_url,
            bytes: img.bytes,
            content_type: img.content_type,
            width: img.width ?? null,
            height: img.height ?? null,
            sha256: img.sha256 ?? null,
            sort_order: typeof img.sort_order === "number" ? img.sort_order : idx,
            is_primary: !!img.is_primary,
          }));
        }
        return payload ;
      }
    
      const listing = prune(listingAll);
      const marketplaces_selected = Array.from(selectedMarketplaceIds.values());

      const payload = { inventory, listing, marketplaces_selected };

      if (Object.keys(ebayListing).length > 0) {
        // Backend: upsert into app.item_marketplace_listing when present
        payload.marketplace_listing = { ebay: ebayListing };
      }

      // If this is a duplicated brand-new item, send source images for server-side copy
      if (
        !__currentItemId &&
        Array.isArray(__duplicateSourceImages) &&
        __duplicateSourceImages.length > 0
      ) {
        payload.duplicate_images = __duplicateSourceImages.map((img, idx) => ({
          r2_key: img.r2_key,
          cdn_url: img.cdn_url,
          bytes: img.bytes,
          content_type: img.content_type,
          width: img.width ?? null,
          height: img.height ?? null,
          sha256: img.sha256 ?? null,
          sort_order: typeof img.sort_order === "number" ? img.sort_order : idx,
          is_primary: !!img.is_primary,
        }));
      }
         
      return payload;
    }


     async function submitIntake(mode = "active") {
      if (mode !== "draft" && !computeValidity()) return;
    
      const payload = buildPayload(mode === "draft");
      console.log("[intake] duplicate_images count", Array.isArray(payload.duplicate_images) ? payload.duplicate_images.length : 0); 
      // If we’re editing an existing item, send its id so the server updates it
      if (__currentItemId) {
        payload.item_id = __currentItemId;
      }
      
      // DEBUG (short): show marketplaces we’re asking for
      console.log("[intake] marketplaces_selected", payload.marketplaces_selected, "has_fb=", payload?.marketplaces_selected?.includes?.("facebook"));
      
      const res = await api("/api/inventory/intake", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
      
      // DEBUG (short): confirm server accepted and returned item_id/status
      if (res?.ok) {
        console.log("[intake] server.ok item_id=", res.item_id, "status=", res.status);
      }
      // Log non-OK responses with full context before throwing
      if (!res || res.ok === false) {
        try {
          console.groupCollapsed("[intake.js] POST /api/inventory/intake failed");
          console.log("payload.sent", payload);                               // what we sent
          console.log("response.raw", res);                                   // what server returned
          console.log("surface_error", res?.error || "intake_failed");
          // If the server started returning more detail (e.g., constraint), show it
          if (res?.message) console.log("message", res.message);
          if (res?.constraint) console.log("constraint", res.constraint);
          if (res?.code) console.log("pg.code", res.code);
        } finally {
          console.groupEnd?.();
        }
        throw new Error(res?.error || "intake_failed");
      }
        
        // Save defaults (local) on success so user gets the same picks next time
        try {
          writeDefaults(Array.from(selectedMarketplaceIds.values()));
        } catch {}

         // NEW: also persist user defaults on the server for this marketplace
        try {
          // Only run if eBay controls exist on the page
          const shipSel = document.getElementById("ebay_shippingPolicy");
          const paySel  = document.getElementById("ebay_paymentPolicy");
          const retSel  = document.getElementById("ebay_returnPolicy");
          const zipEl   = document.getElementById("ebay_shipZip");
          // Pricing format comes from the format select (fixed|auction)
          const fmtSel  = document.getElementById("ebay_formatSelect");
          const boChk   = document.getElementById("ebay_bestOffer");
          const prChk   = document.getElementById("ebay_promote");
        
          if (shipSel || paySel || retSel || zipEl || fmtSel || boChk || prChk) {
            const clean = (v) => (v === undefined || v === null
              ? undefined
              : (typeof v === "string" ? v.trim() : v));
        
            const defaults = {
              shipping_policy: clean(shipSel?.value || ""),
              payment_policy:  clean(paySel?.value  || ""),
              return_policy:   clean(retSel?.value  || ""),
              shipping_zip:    clean(zipEl?.value   || ""),
              pricing_format:  clean((fmtSel?.value || "").toLowerCase()),
              allow_best_offer: boChk ? Boolean(boChk.checked) : undefined,
              promote:          prChk ? Boolean(prChk.checked) : undefined,
            };
        
            await api("/api/inventory/user-defaults?marketplace=ebay", {
              method: "PUT",
              headers: {
                "content-type": "application/json"
              },
              body: JSON.stringify({ defaults }),
            });
          }
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
      
            // If Facebook tile is selected, open a stub window now (user gesture) to avoid popup blocking.
            try {
              const rows = (__metaCache?.marketplaces || []);
              const byId = new Map(rows.map(r => [Number(r.id), String(r.slug || "").toLowerCase()]));
              const wantsFacebook = Array.from(selectedMarketplaceIds).some(id => byId.get(Number(id)) === "facebook");
              if (wantsFacebook) {
                window.__rpFbWin = window.open("about:blank", "_blank", "popup=1");  // no 'noopener' so we keep a handle
                try {
                  const d = window.__rpFbWin && window.__rpFbWin.document;
                  if (d) {
                    d.title = "Preparing Facebook…";
                    d.body.innerHTML = "<p style='font-family:sans-serif;padding:16px'>Preparing Facebook…</p>";
                  }
                } catch {}
                console.log("[intake.js] opened stub FB window", !!window.__rpFbWin);
              }
            } catch {}
      
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
            <button type="button" class="btn btn-ghost btn-sm" data-action="duplicate" data-item-id="${row.item_id}">Duplicate</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="delete" data-item-id="${row.item_id}">Delete</button>
          </div>
        </td>
      `;
      return tr;
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

              // NEW: mirror the Active/Edit path — tell the runner to start with any job_ids
              try {
                const jobIds = Array.isArray(resDel?.job_ids) ? resDel.job_ids : [];
                document.dispatchEvent(new CustomEvent("intake:item-saved", {
                  detail: {
                    action: "delete",
                    save_status: "delete",
                    item_id: __currentItemId,
                    job_ids: jobIds,
                  }
                }));
              } catch {}
              
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

        // Basic + listing fields (now includes Long Description)
        populateFromSaved(res.inventory || {}, res.listing || null);

        // Apply per-item marketplace selection from Neon (eBay, Facebook, etc.)
        try {
          applyMarketplaceSelectionForItem(__metaCache, res.marketplace_listing || null);
        } catch {}

        // If the draft has an eBay listing row, hydrate the eBay card fields/status
        try {
          const ebaySaved = res?.marketplace_listing?.ebay || null;
          const ebayId    = res?.marketplace_listing?.ebay_marketplace_id || null;
          if (ebaySaved) {
            hydrateEbayFromSaved(ebaySaved, ebayId);
          }
        } catch {}

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
          
          } else if (action === "duplicate") {
            btn.addEventListener("click", () => handleDuplicateInventory(id));
          
          } else if (action === "delete") {
            btn.addEventListener("click", () => handleDeleteInventory(id, btn.closest("tr")));
          }
        });
      } catch (err) {
        console.error("drafts:load:error", err);
      }
    }

     // Make loadDrafts available to the refresh bus declared earlier
      try { window.__loadDrafts = loadDrafts; } catch {}
      
      /** Render a single inventory row (Active items) */
      function renderInventoryRow(row) {
        const tr = document.createElement("tr");
        tr.className = "border-b";
        const price = (row.price != null) ? `$${Number(row.price).toFixed(2)}` : "—";
        const qty = (row.qty ?? "—");
        const cat = row.category_nm || "—";
        const title = row.product_short_title || "—";
        const saved = fmtSaved(row.saved_at);
      
        const imgCell = `
          <div class="w-10 h-10 rounded-lg overflow-hidden border" style="width:40px;height:40px">
            ${row.image_url ? `<img src="${row.image_url}" alt="" style="width:40px;height:40px;object-fit:cover" loading="lazy">` : `<div class="w-10 h-10 bg-gray-100"></div>`}
          </div>
        `;
      
        tr.innerHTML = `
          <td class="px-3 py-2 whitespace-nowrap">${saved}</td>
          <td class="px-3 py-2">${imgCell}</td>
          <td class="px-3 py-2 mono">${row.sku || "—"}</td>
          <td class="px-3 py-2">${title}</td>
          <td class="px-3 py-2">${price}</td>
          <td class="px-3 py-2">${qty}</td>
          <td class="px-3 py-2">${cat}</td>
          <td class="px-3 py-2">
            <div class="flex gap-2">
              <button type="button" class="btn btn-primary btn-sm" data-action="load" data-item-id="${row.item_id}">Load</button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="duplicate" data-item-id="${row.item_id}">Duplicate</button>
              <button type="button" class="btn btn-ghost btn-sm" data-action="delete" data-item-id="${row.item_id}">Delete</button>
            </div>
          </td>
        `;
        return tr;
      }
      
      /** Click handler: Delete an inventory item from the list (Active) */
      async function handleDeleteInventory(item_id, rowEl) {
        try {
          const sure = confirm("Delete this item? This cannot be undone.");
          if (!sure) return;
          const res = await api("/api/inventory/intake", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "delete", item_id })
          });
          if (!res || res.ok === false) throw new Error(res?.error || "delete_failed");
          if (rowEl && rowEl.parentElement) rowEl.parentElement.removeChild(rowEl);
          // also nudge the drafts/inventory panes to stay current
          document.dispatchEvent(new CustomEvent("intake:item-changed"));
        } catch (err) {
          console.error("inventory:delete:error", err);
          alert("Failed to delete item.");
        }
      }

            async function handleDuplicateInventory(item_id) {
        try {
          // Reuse the same intake API as Load so we get inventory + listing + images
          const res = await api(`/api/inventory/intake?item_id=${encodeURIComponent(item_id)}`, { method: "GET" });
          if (!res || res.ok === false) throw new Error(res?.error || "load_failed");

          const inv     = res.inventory || {};
          const listing = res.listing   || null;
          const images  = Array.isArray(res.images) ? res.images : [];

          // Build a duplicate "seed" object that looks like a new draft
          const invClone = { ...inv };
          delete invClone.item_id;
          delete invClone.sku;
          invClone.item_status = "draft";

          const seed = {
            inventory: invClone,
            listing,
            images: images.map((img, idx) => ({
              r2_key: img.r2_key,
              cdn_url: img.cdn_url,
              bytes: img.bytes,
              content_type: img.content_type,
              width: img.width_px ?? img.width ?? null,
              height: img.height_px ?? img.height ?? null,
              sha256: img.sha256_hex ?? img.sha256 ?? null,
              sort_order: typeof img.sort_order === "number" ? img.sort_order : idx,
              is_primary: !!img.is_primary,
            })),
          };

          // Stash in sessionStorage so the next page load can hydrate from it
          try {
            sessionStorage.setItem("rp:intake:duplicateSeed", JSON.stringify(seed));
            console.log("[intake.js] duplicateSeed stored", {
              item_id,
              imageCount: seed.images.length,
            });
          } catch (e) {
            console.warn("[intake.js] unable to store duplicateSeed", e);
          }

          // Navigate back into a pristine "new item" intake screen.
          // We just reload the page; init() will detect the seed and hydrate.
          window.location.reload();

        } catch (err) {
          console.error("duplicate:error", err);
          alert("Unable to duplicate item.");
        }
      }


    
      /** Load and render the most recent Active inventory (limit 50) */
      async function loadInventory() {
        try {
          const tbody = document.getElementById("recentInventoryTbody");
          if (!tbody) return;
          const res = await api("/api/inventory/recent?limit=50", { method: "GET" });
          if (!res || res.ok === false) throw new Error(res?.error || "inventory_failed");
          const rows = Array.isArray(res.rows) ? res.rows : [];
      
          tbody.innerHTML = "";
          if (rows.length === 0) {
            const tr = document.createElement("tr");
            tr.innerHTML = `<td class="px-3 py-2 text-gray-500" colspan="8">No inventory found.</td>`;
            tbody.appendChild(tr);
            return;
          }
      
          for (const r of rows) {
            const tr = renderInventoryRow(r);
            tbody.appendChild(tr);
          }
      
          // Wire row buttons
          tbody.querySelectorAll("button[data-action]").forEach((btn) => {
            const action = btn.getAttribute("data-action");
            const id = btn.getAttribute("data-item-id");
            if (action === "load") {
              // reuse the existing loader; it hydrates photos + fields
              btn.addEventListener("click", () => handleLoadDraft(id));
            } else if (action === "duplicate") {
              btn.addEventListener("click", () => handleDuplicateInventory(id));
            } else if (action === "delete") {
              btn.addEventListener("click", () => handleDeleteInventory(id, btn.closest("tr")));
            }
          });
        } catch (err) {
          console.error("inventory:load:error", err);
        }
      }
      
      // Expose for refresh bus
      try { window.__loadInventory = loadInventory; } catch {}
      
      wireCtas();
      wireCopyXeasy();  // enable/wire the Xeasy copy button
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
          // Also enable the Xeasy copy button when this is an Active (non-draft) save
          if (mode !== "draft") {
            try { enableCopyXeasy(true); } catch {}
          }
          // Use a non-blocking toast/banner so the Facebook handoff isn't paused
          if (typeof window.uiToast === "function") {
            window.uiToast(msg);
          } else {
            const id = "intake-save-banner";
            let b = document.getElementById(id);
            if (!b) {
              b = document.createElement("div");
              b.id = id;
              b.className = "alert alert-success mb-2";
              document.body.appendChild(b);
            }
            b.textContent = msg;
          }
          // Remember the item id for subsequent edits/saves
          __currentItemId = res?.item_id || __currentItemId;
          // Also stash on the form for resilience (not strictly required)
          try {
            const form = document.getElementById("intakeForm");
            if (form && __currentItemId) form.dataset.itemId = __currentItemId;
          } catch (e) {}

          // notify photos module to flush any pending uploads
            
          try {
            document.dispatchEvent(
              new CustomEvent("intake:item-saved", {
                detail: {
                  item_id: __currentItemId,
                  action: "save",
                  save_status: (mode === "draft" ? "draft" : "active"),
                  job_ids: Array.isArray(res?.job_ids) ? res.job_ids : []
                }
              })
            );
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
