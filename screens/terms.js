// screens/terms.js
(function () {
  function fmt(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  const el = document.getElementById("terms-effective");
  if (el) el.textContent = `Effective date: ${fmt(new Date())}`;
})();
