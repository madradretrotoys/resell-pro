// Begin functions/api/images/attach.ts
// /functions/api/images/attach.ts
import { neon } from "@neondatabase/serverless";
import { getEffectiveTenantActor, isPlatformScopedActor } from "../../_shared/auth";

const json = (d:any,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}});

function readCookie(header:string,name:string){if(!header)return null;for(const part of header.split(/; */)){const[k,...r]=part.split("=");if(k===name)return decodeURIComponent(r.join("="));}return null;}
async function verifyJwtHS256(token:string, secret:string){
  const enc=new TextEncoder(); const [h,p,s]=token.split("."); if(!h||!p||!s) throw new Error("bad_token");
  const toBytes=(str:string)=>{const pad="=".repeat((4-(str.length%4))%4);const b64=(str+pad).replace(/-/g,"+").replace(/_/g,"/");const bin=atob(b64);return Uint8Array.from(bin,c=>c.charCodeAt(0));};
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  const ok=await crypto.subtle.verify("HMAC",key,toBytes(s),enc.encode(`${h}.${p}`));
  if(!ok) throw new Error("bad_sig");
  return JSON.parse(new TextDecoder().decode(toBytes(p)));
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok:false, error:"no_cookie" }, 401);
    const payload = await verifyJwtHS256(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok:false, error:"bad_token" }, 401);

    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok:false, error:"missing_tenant" }, 400);

    const { item_id, r2_key, cdn_url, bytes, content_type, width, height, sha256 } = await request.json();
    if (!item_id || !r2_key) return json({ ok:false, error:"missing_params" }, 400);

    const sql = neon(String(env.DATABASE_URL));

    // AuthZ — direct tenant access or inherited organization/business/platform access.
    // Platform/internal users still need explicit Inventory Intake permission.
    const actor = await getEffectiveTenantActor(sql, tenant_id, actor_user_id);
    if (!actor || actor.active === false) return json({ ok: false, error: "forbidden" }, 403);
    const allow = isPlatformScopedActor(actor)
      ? !!actor.can_inventory_intake
      : (["owner", "admin", "manager"].includes(actor.role) || !!actor.can_inventory_intake);
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    const count = await sql<{ n:string }[]>`select count(*)::text as n from app.item_images where item_id=${item_id}`;
    const is_primary = Number(count[0].n) === 0;

    const rows = await sql<{ image_id:string }[]>`
      insert into app.item_images
        (tenant_id, item_id, r2_key, cdn_url, bytes, content_type, width_px, height_px, sha256_hex, is_primary, sort_order)
      values
        (${tenant_id}, ${item_id}, ${r2_key}, ${cdn_url}, ${bytes}, ${content_type}, ${width}, ${height}, ${sha256}, ${is_primary}, ${count[0].n})
      returning image_id
    `;
    return json({ ok:true, image_id: rows[0].image_id, is_primary }, 200);
  } catch (e:any) {
    return json({ ok:false, error:String(e?.message||e) }, 500);
  }
};


// end functions/api/images/attach.ts

