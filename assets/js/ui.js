//begin ui.js

export function showToast(msg, ms=2500){
  const el = Object.assign(document.createElement('div'), { textContent: msg });
  Object.assign(el.style,{position:'fixed',bottom:'16px',left:'50%',transform:'translateX(-50%)',background:'#222',color:'#fff',padding:'8px 12px',borderRadius:'8px',zIndex:'9999'});
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), ms);
}

/* Button role normalizer (kept) */
export function applyButtonGroupColors(root, options = {}){
  if (!root) return;
  const { allGhost = false } = options;
  const hasColorRole = (btn) =>
  btn.classList.contains('btn-primary') ||
  btn.classList.contains('btn-secondary') ||
  btn.classList.contains('btn-ghost') ||
  btn.classList.contains('btn-danger') ||
  btn.classList.contains('btn-success'); // respect green buttons

  const btns = Array.from(root.querySelectorAll('button.btn'));
  if (allGhost){
    btns.forEach((btn) => { if (!hasColorRole(btn)) btn.classList.add('btn-ghost'); });
    return;
  }
  let madePrimary = false;
  btns.forEach((btn) => {
    if (hasColorRole(btn)) return; /* don't override explicit color */
    if (!madePrimary){ btn.classList.add('btn-primary'); madePrimary = true; }
    else { btn.classList.add('btn-ghost'); }
  });
}

/* Convenience: run on any .btn-group under a root */
export function normalizeButtonGroups(root=document){
  root.querySelectorAll('.btn-group').forEach((g)=>applyButtonGroupColors(g));
}

/**
 * Shared Inventory Image Lightbox helper.
 *
 * Any screen can:
 *   - Include a <dialog id="inventoryImageViewer"> with
 *       <img id="inventoryImageViewerImg">
 *   - Render thumbnails/buttons with class "inventory-thumb-btn"
 *     and data-image-url="https://..."
 *   - Call wireInventoryImageLightbox(container)
 *
 * This will bind click handlers that open the dialog with the
 * clicked image URL, avoiding duplicate bindings on re-render.
 */
export function wireInventoryImageLightbox(root = document) {
  try {
    if (!root) root = document;

    const viewer    = document.getElementById("inventoryImageViewer");
    const viewerImg = document.getElementById("inventoryImageViewerImg");

    if (!viewer || !viewerImg) return;

    const buttons = root.querySelectorAll(
      ".inventory-thumb-btn[data-image-url]"
    );

    buttons.forEach((btn) => {
      if (!btn) return;

      // Avoid double-binding when the table re-renders
      if (btn.dataset.lightboxBound === "1") return;
      btn.dataset.lightboxBound = "1";

      btn.addEventListener("click", () => {
        const url = btn.getAttribute("data-image-url");
        if (!url) return;

        viewerImg.src = url;

        try {
          if (typeof viewer.showModal === "function") {
            viewer.showModal();
          } else {
            viewer.setAttribute("open", "true");
          }
        } catch {
          viewer.setAttribute("open", "true");
        }
      });
    });
  } catch (err) {
    console.error("[ui] wireInventoryImageLightbox error", err);
  }
}

//end ui.js
