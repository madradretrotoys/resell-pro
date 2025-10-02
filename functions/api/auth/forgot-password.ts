import { neon } from "@neondatabase/serverless";

type Body = { id?: string };

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  const { id } = (await request.json().catch(() => ({}))) as Body;
  if (!id) return json({ error: "User ID or Email is required." }, 400);

  const sql = neon(env.DATABASE_URL as string);
  const users = await sql<
    { user_id: string; email: string | null }[]
  >`SELECT user_id, email FROM app.users WHERE login_id = ${id} OR email = ${id} LIMIT 1`;

  if (users.length === 0) {
    // do not enumerate
    return json({ ok: true, message: "If the account has email, a reset link was sent." });
  }

  const user = users[0];
  if (!user.email) {
    // Store policy: employees without email need manager-assisted reset
    return json({ ok: true, message: "Ask a manager to reset your password." });
  }

  // Create a reset token (30 min expiry) in app.password_resets
  const token = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await sql`
    INSERT INTO app.password_resets (user_id, token, expires_at)
    VALUES (${user.user_id}, ${token}, ${expiresAt})`;

  // TODO: email the reset link to user.email
  // e.g., https://yourdomain/reset.html?token=${token}
  // (Email send omitted in this stub.)

  return json({ ok: true, message: "If the account has email, a reset link was sent." });
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
