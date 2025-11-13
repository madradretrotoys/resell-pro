// screens/privacy.js
(function () {
  // Simple helper: format a date as YYYY-MM-DD
  function fmt(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const effective = document.getElementById("privacy-effective");
  if (effective) {
    effective.textContent = `Effective date: ${fmt(new Date())}`;
  }

  // If you implement a dedicated deletion endpoint, set it here:
  const deletionUrl = "https://resellpros.com/api/settings/marketplaces/facebook/data-deletion";
  const deletionLink = document.getElementById("privacy-deletion-link");
  if (deletionLink) {
    deletionLink.textContent = deletionUrl;
    deletionLink.href = deletionUrl;
  }
})();
