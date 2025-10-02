import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

type LoginBody = { id?: string; password?: string };

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const { id, password } = (await request.json().catch(() => ({}))) as LoginBody;
    if (!id || !password) return json({ error: "Missing id or password." }, 400);

    const sql = neon(env.DATABASE_URL as string);
    const rows = await sql<
      { user_id: string; login_id: string; email: string | null; password_hash: string | null }[]
    >`SELECT user_id, login_id, email, password_hash
       FROM app.users
       WHERE login_id = ${id} OR email = ${id}
       LIMIT 1`;

    if (rows.length === 0) return json({ error: "Invalid credentials." }, 401);
    const u = rows[0];

    if (!u.password_hash) return json({ error: "Password not set." }, 401);
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return json({ error: "Invalid credentials." }, 401);

    // TODO: set a real session cookie. For now the frontend just checks 200 OK.
    return json({ ok: true, user: { user_id: u.user_id, login_id: u.login_id, email: u.email } });
  } catch (err: any) {
    return json({ error: err?.message || "Server error." }, 500);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
