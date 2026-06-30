import { neon } from "@neondatabase/serverless";
import { requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function cleanOptionalText(value: unknown, max = 255) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanDigitsText(value: unknown, max = 32) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  return digits ? digits.slice(0, max) : null;
}

function safeFilename(value: string) {
  return (value || "logo.bin").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "logo.bin";
}

async function getImageDimensions(bytes: ArrayBuffer, contentType: string) {
  try {
    // @ts-ignore - ImageDecoder is available in the Cloudflare Workers runtime.
    const dec = new ImageDecoder({ data: new Uint8Array(bytes), type: contentType });
    const frame = await dec.decode();
    return { width_px: frame.image.displayWidth as number, height_px: frame.image.displayHeight as number };
  } catch {
    return { width_px: null, height_px: null };
  }
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const requestContentType = request.headers.get("content-type") || "";
    let body: any = {};
    let logoFile: File | null = null;
    if (requestContentType.startsWith("multipart/form-data")) {
      const form = await request.formData();
      body = Object.fromEntries(form.entries());
      const file = form.get("logo");
      if (file && (file as any).arrayBuffer && (file as File).size > 0) logoFile = file as File;
    } else {
      body = await request.json().catch(() => ({} as any));
    }

    const tenantId = String(body.tenant_id || "").trim();
    const name = String(body.name || "").trim();
    const slug = slugify(String(body.slug || name));
    const streetAddress = cleanOptionalText(body.street_address, 255);
    const city = cleanOptionalText(body.city, 100);
    const state = cleanOptionalText(body.state, 50);
    const zip = cleanDigitsText(body.zip, 16);
    const phone = cleanDigitsText(body.phone, 32);
    const email = cleanOptionalText(body.email, 255);
    const businessId = cleanOptionalText(body.business_id, 80);

    if (!isUuid(tenantId)) return json({ ok: false, error: "invalid_tenant" }, 400);
    if (!name) return json({ ok: false, error: "missing_name" }, 400);
    if (!slug) return json({ ok: false, error: "invalid_slug" }, 400);
    if (businessId && !isUuid(businessId)) return json({ ok: false, error: "invalid_business" }, 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
    if (logoFile && !/^image\//i.test(logoFile.type || "")) return json({ ok: false, error: "logo_not_image" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const [access] = await sql<{ ok: boolean }[]>`
      SELECT (
        EXISTS (
          SELECT 1
          FROM app.memberships m
          WHERE m.tenant_id = ${tenantId}::uuid
            AND m.user_id = ${auth.actor_user_id}
            AND m.active = true
            AND m.role IN ('owner','admin','manager')
        )
        OR EXISTS (
          SELECT 1
          FROM app.permissions p
          WHERE p.user_id = ${auth.actor_user_id}
            AND COALESCE(p.can_add_tenant, false) = true
        )
      ) AS ok
    `;
    if (!access?.ok) return json({ ok: false, error: "forbidden" }, 403);

    if (businessId) {
      const [businessAccess] = await sql<{ ok: boolean }[]>`
        SELECT (
          EXISTS (
            SELECT 1
            FROM app.business_memberships bm
            WHERE bm.business_id = ${businessId}::uuid
              AND bm.user_id = ${auth.actor_user_id}
              AND bm.active = true
              AND bm.role IN ('owner','admin','manager')
          )
          OR EXISTS (
            SELECT 1
            FROM app.permissions p
            WHERE p.user_id = ${auth.actor_user_id}
              AND COALESCE(p.can_add_tenant, false) = true
          )
        ) AS ok
      `;
      if (!businessAccess?.ok) return json({ ok: false, error: "forbidden_business" }, 403);
    }

    const [updated] = await sql/*sql*/`
      UPDATE app.tenants
      SET name = ${name},
          slug = ${slug},
          business_id = ${businessId || null}::uuid,
          "Street Address" = ${streetAddress},
          "City" = ${city},
          "State" = ${state},
          "Zip" = ${zip},
          "Phone" = ${phone},
          email = ${email}
      WHERE tenant_id = ${tenantId}::uuid
      RETURNING tenant_id, business_id, name, slug, "Street Address" AS street_address, "City" AS city, "State" AS state, "Zip" AS zip, "Phone" AS phone, email, created_at
    `;
    if (!updated) return json({ ok: false, error: "tenant_not_found" }, 404);

    let logo = null;
    if (logoFile) {
      const logoBytes = await logoFile.arrayBuffer();
      if (logoBytes.byteLength < 128) return json({ ok: false, error: "logo_empty_or_too_small" }, 400);
      const logoContentType = logoFile.type || "application/octet-stream";
      const shaBuf = await crypto.subtle.digest("SHA-256", logoBytes);
      const logoSha256Hex = Array.from(new Uint8Array(shaBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const logoDimensions = await getImageDimensions(logoBytes, logoContentType);
      const r2_key = `Tenant Logos/${tenantId}/${crypto.randomUUID()}__${safeFilename(logoFile.name)}`;
      // @ts-ignore - R2 binding is provided by Cloudflare Pages.
      await env.R2_IMAGES.put(r2_key, logoBytes, { httpMetadata: { contentType: logoContentType } });
      const base = env.IMG_BASE_URL || "";
      const cdn_url = base ? `${base}/${r2_key}` : "";
      await sql/*sql*/`UPDATE app.tenant_logos SET is_active = false WHERE tenant_id = ${tenantId}::uuid AND is_active = true`;
      const [insertedLogo] = await sql/*sql*/`
        INSERT INTO app.tenant_logos (tenant_id, r2_key, content_type, bytes, width_px, height_px, sha256_hex, cdn_url, is_active)
        VALUES (${tenantId}::uuid, ${r2_key}, ${logoContentType}, ${logoBytes.byteLength}, ${logoDimensions.width_px}, ${logoDimensions.height_px}, ${logoSha256Hex}, ${cdn_url}, true)
        RETURNING logo_id, tenant_id, r2_key, content_type, bytes, width_px, height_px, sha256_hex, cdn_url, is_active, created_at
      `;
      logo = insertedLogo;
    }

    return json({ ok: true, tenant: updated, logo });
  } catch (e: any) {
    const message = e?.message || String(e);
    if (message.includes("tenants_slug_key")) return json({ ok: false, error: "slug_exists" }, 409);
    return json({ ok: false, error: "server_error", message }, 500);
  }
};
