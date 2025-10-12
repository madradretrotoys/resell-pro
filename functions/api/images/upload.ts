// functions/api/images/upload.ts
import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function verifyJwtHS256(token: string, secret: string): Promise<any> {
  const enc = new TextEncoder();
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("bad_token");
  const toBytes = (str: string) => {
    const pad = "=".repeat((4 - (str.length % 4)) % 4);
    const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, toBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  return JSON.parse(new TextDecoder().decode(toBytes(p)));
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    // AuthN
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    const payload = await verifyJwtHS256(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    // Tenant
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    // AuthZ (mirror inventory-intake guard: owner/admin/manager or can_inventory_intake)
    const sql = neon(String(env.DATABASE_URL));
    const roleQ = await sql<{ role: string; active: boolean; can_inventory_intake: boolean | null }[]>`
      SELECT m.role, m.active, COALESCE(p.can_inventory_intake, false) AS can_inventory_intake
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;
    if (roleQ.length === 0 || roleQ[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const allow = ["owner", "admin", "manager"].includes(roleQ[0].role) || !!roleQ[0].can_inventory_intake;
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    // Parse body: allow multipart OR raw bytes
    let contentType = request.headers.get("content-type") || "";
    let filename = "";
    let bytes: ArrayBuffer;

    if (contentType.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || !(file as any).arrayBuffer) return json({ ok: false, error: "missing_file" }, 400);
      const f = file as unknown as File;
      filename = f.name || "upload.bin";
      contentType = f.type || "application/octet-stream";
      bytes = await f.arrayBuffer();
    } else {
      // raw body (fetch/PUT)
      filename = new URL(request.url).searchParams.get("filename") || "upload.bin";
      if (!contentType) contentType = "application/octet-stream";
      bytes = await request.arrayBuffer();
    }

    // Generate object key: tenant/YYYY/MM/sku_or_item/itemid/random-filename
    const item_id = new URL(request.url).searchParams.get("item_id") || "unassigned";
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, "0");
    const rand = crypto.randomUUID();
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const r2_key = `${tenant_id}/${y}/${m}/${item_id}/${rand}__${safe}`;

    // Optional: compute sha256 for de-dup
    const shaBuf = await crypto.subtle.digest("SHA-256", bytes);
    const sha256_hex = Array.from(new Uint8Array(shaBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

    // Try to sniff width/height if image (lightweight, via ImageDecoder where available)
    let width_px: number | undefined;
    let height_px: number | undefined;
    try {
      // @ts-ignore - ImageDecoder is available in Workers runtime
      const dec = new ImageDecoder({ data: new Uint8Array(bytes), type: contentType });
      const frame = await dec.decode();
      width_px = frame.image.displayWidth;
      height_px = frame.image.displayHeight;
    } catch { /* non-image or not supported */ }

    // Store to R2
    // @ts-ignore
    await env.R2_IMAGES.put(r2_key, bytes, {
      httpMetadata: { contentType },
    });

    // Build CDN URL (served by our read function below)
    const base = env.IMG_BASE_URL || ""; // e.g. https://img.resell.pro
    const cdn_url = base ? `${base}/i/${encodeURIComponent(String(tenant_id))}/${encodeURIComponent(r2_key.split("/").slice(2).join("/"))}` : "";

    return json({
      ok: true,
      r2_key,
      cdn_url,
      bytes: bytes.byteLength,
      content_type: contentType,
      width: width_px ?? null,
      height: height_px ?? null,
      sha256: sha256_hex
    }, 200);
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err || "upload_failed") }, 500);
  }
};
