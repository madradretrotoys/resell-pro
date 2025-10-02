export function showToast(msg, ms=2500){
  const el = Object.assign(document.createElement('div'), { textContent: msg });
  Object.assign(el.style,{position:'fixed',bottom:'16px',left:'50%',transform:'translateX(-50%)',background:'#222',color:'#fff',padding:'8px 12px',borderRadius:'8px',zIndex:'9999'});
  document.body.appendChild(el); setTimeout(()=>el.remove(), ms);
}
