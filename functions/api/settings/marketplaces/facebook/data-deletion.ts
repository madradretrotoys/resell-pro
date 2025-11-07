// Cloudflare Pages Function — Data Deletion Callback for Meta
// Path: /api/settings/marketplaces/facebook/data-deletion
//
// What it does:
// - Accepts GET or POST with `signed_request` (Meta sends this).
// - Returns JSON containing a URL where the user can check the deletion request
//   and a confirmation code (required by Meta).
//
// Notes:
// - This lightweight version does NOT persist to a DB. If you want to persist,
//   store { code, user_id?, timestamp } in Neon and show true status on the
//   status page. For now, the status page simply shows "received" with the code.

type Env = {
  APP_BASE_URL?: string; // optional convenience (e.g., https://resellpros.com)
  // (Optional) if you want to verify the signed_request signature:
  // FB_APP_SECRET?: string;
};

function parseSignedRequest(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    // Format: signature.payload (both base64url)
    const parts = raw.split(".");
    if (parts.length !== 2) return null;

    const payload = parts[1];
    const json = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
      )
    );
    return json;
  } catch {
    return null;
  }
}

function b64url(input: string) {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function uuidLike(): string {
  // simple, URL-safe id (not crypto-strong, fine for confirmation code)
  const rand = crypto.getRandomValues(new Uint8Array(16));
  return b64url(String.fromCharCode(...rand));
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  let signedRequest: string | null = null;

  if (method === "GET") {
    signedRequest = url.searchParams.get("signed_request");
  } else if (method === "POST") {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        const body = await request.json();
        signedRequest = (body && (body as any).signed_request) || null;
      } catch { /* ignore */ }
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      const body = await request.text();
      const params = new URLSearchParams(body);
      signedRequest = params.get("signed_request");
    }
  } else {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Extract some context (optional)
  const parsed = parseSignedRequest(signedRequest || undefined);
  // const userId = parsed?.user_id; // may be present depending on request type

  // Generate a confirmation code and a status URL the user can visit
  const code = uuidLike();
  const base =
    env.APP_BASE_URL?.replace(/\/+$/, "") ||
    `${url.protocol}//${url.host}`;

  // Public status page (below) shows receipt + code
  const statusUrl = `${base}/screens/data-deletion.html?code=${encodeURIComponent(code)}`;

  // Minimal Meta-required JSON response:
  // https://developers.facebook.com/docs/development/build-and-test/data-deletion-callback
  const payload = {
    url: statusUrl,
    confirmation_code: code,
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
};
