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
    btn.classList.contains('btn-danger');

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
