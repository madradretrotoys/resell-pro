export const onRequest: PagesFunction<{ FB_WEBHOOK_VERIFY_TOKEN: string }> = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);

  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && verifyToken === env.FB_WEBHOOK_VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method === "POST") {
    let body: unknown = null;
    try { body = await request.json(); } catch {}
    return new Response("OK", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
};
