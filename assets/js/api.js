function getCookie(name){ const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\\]\\\\/+^])/g,'\\$1') + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; }
export async function api(path, opts={}){
  const headers = new Headers(opts.headers||{});
  if (!headers.has('content-type') && opts.body && typeof opts.body === 'object') headers.set('content-type','application/json');
  headers.set('accept','application/json');
    const tenant = getCookie('tenant'); if(tenant) headers.set('x-tenant-id', tenant);
    const resp = await fetch(path, {
    method: opts.method || 'GET',
    credentials: 'include',
    headers,
    body: opts.body && typeof opts.body === 'object' ? JSON.stringify(opts.body) : opts.body,
    cache: 'no-store'
  });
  const text = await resp.text(); let data; try{ data = text ? JSON.parse(text) : null; }catch{ data = { raw:text }; }
  if(!resp.ok) throw Object.assign(new Error('API error'), { status: resp.status, data });
  return data;
}
