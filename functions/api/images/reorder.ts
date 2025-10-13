// /functions/api/images/reorder.ts
import { neon } from "@neondatabase/serverless";
const json=(d:any,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}});
function readCookie(h:string,n:string){if(!h)return null;for(const p of h.split(/; */)){const[k,...r]=p.split("=");if(k===n)return decodeURIComponent(r.join("="));}return null;}
async function verify(token:string,secret:string){const enc=new TextEncoder();const[a,b,c]=token.split(".");if(!a||!b||!c)throw new Error("bad_token");
  const toBytes=(s:string)=>{const pad="=".repeat((4-(s.length%4))%4);const b64=(s+pad).replace(/-/g,"+").replace(/_/g,"/");const bin=atob(b64);return Uint8Array.from(bin,(ch)=>ch.charCodeAt(0));};
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  const ok=await crypto.subtle.verify("HMAC",key,toBytes(c),enc.encode(`${a}.${b}`)); if(!ok) throw new Error("bad_sig");
  return JSON.parse(new TextDecoder().decode(toBytes(b)));}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const cookie = request.headers.get("cookie") || "";
    const token = readCookie(cookie, "__Host-rp_session");
    if (!token) return json({ ok:false, error:"no_cookie" }, 401);
    await verify(token, String(env.JWT_SECRET));

    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok:false, error:"missing_tenant" }, 400);

    const { item_id, orders } = await request.json();
    if (!item_id || !Array.isArray(orders)) return json({ ok:false, error:"missing_params" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    for (const o of orders) {
      await sql/*sql*/`
        update app.item_images
        set sort_order=${o.sort_order}
        where image_id=${o.image_id} and item_id=${item_id} and tenant_id=${tenant_id}
      `;
    }
    return json({ ok:true }, 200);
  } catch (e:any) {
    return json({ ok:false, error:String(e?.message||e) }, 500);
  }
};
