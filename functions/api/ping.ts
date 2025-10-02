export const onRequestGet: PagesFunction = async () =>
  new Response("pong", { headers: { "content-type": "text/plain" } });
