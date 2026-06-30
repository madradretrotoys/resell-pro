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
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function ensureOrganizationAndBusiness(sql: ReturnType<typeof neon>, actorUserId: string, body: any) {
  const organizationName = cleanOptionalText(body.organization_name, 255);
  const businessName = cleanOptionalText(body.business_name, 255);

  if (!organizationName && !businessName) return null;
  if (!organizationName) throw new Error("missing_organization_name");
  if (!businessName) throw new Error("missing_business_name");

  const requestedOrganizationSlug = cleanOptionalText(body.organization_slug, 80);
  const organizationSlug = slugify(requestedOrganizationSlug || organizationName);
  const requestedBusinessSlug = cleanOptionalText(body.business_slug, 80);
  const businessSlug = slugify(requestedBusinessSlug || businessName);

  if (!organizationSlug) throw new Error("invalid_organization_slug");
  if (!businessSlug) throw new Error("invalid_business_slug");

  const [organization] = await sql/*sql*/`
    INSERT INTO app.organizations (name, slug, created_by_user_id, updated_by_user_id)
    VALUES (${organizationName}, ${organizationSlug}, ${actorUserId}, ${actorUserId})
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      status = 'active',
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
    RETURNING organization_id, name, slug
  `;

  await sql/*sql*/`
    INSERT INTO app.organization_memberships (organization_id, user_id, role, active)
    VALUES (${organization.organization_id}, ${actorUserId}, 'owner', true)
    ON CONFLICT (organization_id, user_id) DO UPDATE SET
      role = EXCLUDED.role,
      active = true,
      updated_at = now()
  `;

  const [business] = await sql/*sql*/`
    INSERT INTO app.businesses (organization_id, name, slug, created_by_user_id, updated_by_user_id)
    VALUES (${organization.organization_id}, ${businessName}, ${businessSlug}, ${actorUserId}, ${actorUserId})
    ON CONFLICT (organization_id, slug) DO UPDATE SET
      name = EXCLUDED.name,
      status = 'active',
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
    RETURNING business_id, organization_id, name, slug
  `;

  await sql/*sql*/`
    INSERT INTO app.business_memberships (business_id, user_id, role, active)
    VALUES (${business.business_id}, ${actorUserId}, 'owner', true)
    ON CONFLICT (business_id, user_id) DO UPDATE SET
      role = EXCLUDED.role,
      active = true,
      updated_at = now()
  `;

  return { organization, business };
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const sql = neon(String(env.DATABASE_URL));
    const [access] = await sql<{ has_active_membership: boolean; can_add_tenant: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1
          FROM app.memberships m
          WHERE m.user_id = ${auth.actor_user_id} AND m.active = true
        ) AS has_active_membership,
        (
          EXISTS (
            SELECT 1
            FROM app.memberships m
            WHERE m.user_id = ${auth.actor_user_id} AND m.active = true AND m.role = 'owner'
          )
          OR EXISTS (
            SELECT 1
            FROM app.permissions p
            WHERE p.user_id = ${auth.actor_user_id} AND COALESCE(p.can_add_tenant, false) = true
          )
        ) AS can_add_tenant
    `;

    if (!access?.has_active_membership || !access.can_add_tenant) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

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

    const name = String(body.name || "").trim();
    const requestedSlug = String(body.slug || "").trim();
    const slug = slugify(requestedSlug || name);
    const streetAddress = cleanOptionalText(body.street_address, 255);
    const city = cleanOptionalText(body.city, 100);
    const state = cleanOptionalText(body.state, 50);
    const zip = cleanDigitsText(body.zip, 16);
    const phone = cleanDigitsText(body.phone, 32);
    const email = cleanOptionalText(body.email, 255);

    if (!name) return json({ ok: false, error: "missing_name" }, 400);
    if (!slug) return json({ ok: false, error: "invalid_slug" }, 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
    if (logoFile && !/^image\//i.test(logoFile.type || "")) return json({ ok: false, error: "logo_not_image" }, 400);

    const hierarchy = await ensureOrganizationAndBusiness(sql, auth.actor_user_id, body);

    let logoBytes: ArrayBuffer | null = null;
    let logoContentType = "";
    let logoSha256Hex = "";
    let logoDimensions: { width_px: number | null; height_px: number | null } | null = null;
    if (logoFile) {
      logoBytes = await logoFile.arrayBuffer();
      if (logoBytes.byteLength < 128) return json({ ok: false, error: "logo_empty_or_too_small" }, 400);
      logoContentType = logoFile.type || "application/octet-stream";
      const shaBuf = await crypto.subtle.digest("SHA-256", logoBytes);
      logoSha256Hex = Array.from(new Uint8Array(shaBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      logoDimensions = await getImageDimensions(logoBytes, logoContentType);
    }

    const [created] = await sql/*sql*/`
      WITH new_tenant AS (
        INSERT INTO app.tenants (name, slug, business_id, "Street Address", "City", "State", "Zip", "Phone", email)
        VALUES (${name}, ${slug}, ${hierarchy?.business?.business_id || null}, ${streetAddress}, ${city}, ${state}, ${zip}, ${phone}, ${email})
        RETURNING tenant_id, name, slug, business_id, "Street Address" AS street_address, "City" AS city, "State" AS state, "Zip" AS zip, "Phone" AS phone, email, created_at
      ), new_membership AS (
        INSERT INTO app.memberships (tenant_id, user_id, role, active)
        SELECT tenant_id, ${auth.actor_user_id}, 'owner', true
        FROM new_tenant
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true
      ), new_settings AS (
        INSERT INTO app.tenant_settings (tenant_id, created_by_user_id, updated_by_user_id)
        SELECT tenant_id, ${auth.actor_user_id}, ${auth.actor_user_id}
        FROM new_tenant
        ON CONFLICT (tenant_id) DO NOTHING
      )
      SELECT tenant_id, name, slug, business_id, street_address, city, state, zip, phone, email, created_at
      FROM new_tenant
    `;

    let logo = null;
    if (logoFile && logoBytes && logoDimensions) {
      const r2_key = `Tenant Logos/${created.tenant_id}/${crypto.randomUUID()}__${safeFilename(logoFile.name)}`;
      // @ts-ignore - R2 binding is provided by Cloudflare Pages.
      await env.R2_IMAGES.put(r2_key, logoBytes, { httpMetadata: { contentType: logoContentType } });
      const base = env.IMG_BASE_URL || "";
      const cdn_url = base ? `${base}/${r2_key}` : "";
      const [insertedLogo] = await sql/*sql*/`
        INSERT INTO app.tenant_logos (tenant_id, r2_key, content_type, bytes, width_px, height_px, sha256_hex, cdn_url, is_active)
        VALUES (${created.tenant_id}, ${r2_key}, ${logoContentType}, ${logoBytes.byteLength}, ${logoDimensions.width_px}, ${logoDimensions.height_px}, ${logoSha256Hex}, ${cdn_url}, true)
        RETURNING logo_id, tenant_id, r2_key, content_type, bytes, width_px, height_px, sha256_hex, cdn_url, is_active, created_at
      `;
      logo = insertedLogo;
    }

    return json({ ok: true, tenant: created, organization: hierarchy?.organization || null, business: hierarchy?.business || null, logo });
  } catch (e: any) {
    const message = e?.message || String(e);
    if (message.includes("tenants_slug_key")) return json({ ok: false, error: "slug_exists" }, 409);
    if (message === "missing_organization_name") return json({ ok: false, error: message }, 400);
    if (message === "missing_business_name") return json({ ok: false, error: message }, 400);
    if (message === "invalid_organization_slug") return json({ ok: false, error: message }, 400);
    if (message === "invalid_business_slug") return json({ ok: false, error: message }, 400);
    return json({ ok: false, error: "server_error", message }, 500);
  }
};
