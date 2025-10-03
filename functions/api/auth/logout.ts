export const onRequestPost: PagesFunction = async () => {
  const clearHostCookie = [
    "rp_jwt=",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");

  const clearDomainCookie = [
    "rp_jwt=",
    "Path=/",
    "Domain=.resell-pro.pages.dev",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");

  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", clearHostCookie);
  headers.append("set-cookie", clearDomainCookie);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
