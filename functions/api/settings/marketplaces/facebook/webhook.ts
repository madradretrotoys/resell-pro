export const onRequestGet: PagesFunction<{ FB_WEBHOOK_VERIFY_TOKEN: string }> = async ({ request, env }) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  // Trim to avoid hidden spaces
  const expected = (env.FB_WEBHOOK_VERIFY_TOKEN || "").trim();
  const provided = (token || "").trim();

  if (mode === "subscribe" && challenge && expected && provided === expected) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("Forbidden", { status: 403 });
};

export const onRequestPost: PagesFunction = async ({ request }) => {
  // (Optional) validate x-hub-signature-256 header using your App Secret
  // const sig = request.headers.get("x-hub-signature-256") || "";

  // Ack quickly to prevent retries; process async elsewhere
  try { await request.json(); } catch {}
  return new Response("OK", { status: 200 });
};

// (Optional) respond nicely to HEAD used by some health checks
export const onRequestHead: PagesFunction = async () => new Response(null, { status: 200 });
