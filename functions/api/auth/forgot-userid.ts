import { neon } from "@neondatabase/serverless";

type Body = { email?: string };

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  const { email } = (await request.json().catch(() => ({}))) as Body;
  if (!email) return json({ error: "Email required." }, 400);

  const sql = neon(env.DATABASE_URL as string);
  const rows = await sql<{ login_id: string }[]>
    `SELECT login_id FROM app.users WHERE email = ${email} LIMIT 1`;

  // Do not leak existence. Always return 200 with a generic message.
  // TODO: If using email, send the login_id here via your email provider.
  // e.g., SendGrid using env.SENDGRID_KEY (omitted in this stub).
  return json({ ok: true, message: "If that email exists, we sent the User ID." });
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
