// Simple status display for data-deletion.html
(function () {
  const p = new URLSearchParams(location.search);
  const code = p.get("code");

  const statusEl = document.getElementById("dd-status");
  const codeEl = document.getElementById("dd-code");

  if (code) {
    statusEl.textContent = "Request received.";
    codeEl.textContent = `Confirmation code: ${code}`;
  } else {
    statusEl.textContent = "No confirmation code provided.";
  }
})();
