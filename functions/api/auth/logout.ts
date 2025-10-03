export const onRequestPost: PagesFunction = async () => {
  const cookie = [
      "rp_jwt=",
      "Path=/",
      "Domain=.resell-pro.pages.dev",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    ].join("; ");  
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie }
  });
};
