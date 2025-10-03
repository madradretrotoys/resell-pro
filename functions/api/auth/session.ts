// Verifies rp_session cookie and returns the user payload for the app shell.
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64uToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
async function verify(secret: string, token: string) {
  const [p1, p2, sig] = token.split(".");
  if (!p1 || !p2 || !sig) throw new Error("Bad token");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false
