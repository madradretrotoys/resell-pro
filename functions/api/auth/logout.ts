export const onRequestPost: PagesFunction = async () => {
  const clearV2 = [
    "__Host-rp_session=",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");

  const clearLegacyHost = [
    "rp_jwt=",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");

  const clearLegacyDomain = [
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
  headers.append("set-cookie", clearV2);
  headers.append("set-cookie", clearLegacyHost);
  headers.append("set-cookie", clearLegacyDomain);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
