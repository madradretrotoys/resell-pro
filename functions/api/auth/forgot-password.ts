import { neon } from "@neondatabase/serverless";

type Body = { id?: string };

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const { id } = (await request.json().catch(() => ({}))) as Body;
    if (!id) return json({ error: "User ID or Email is required." }, 400);

    const sql = neon(env.DATABASE_URL as string);

    const users = await sql<
      { user_id: string; email: string | null }[]
    >`SELECT user_id, email FROM app.users WHERE login_id = ${id} OR email = ${id} LIMIT 1`;

    // Generic response to avoid enumeration
    const generic = { ok: true, message: "If the account has email, a reset link was sent." };

    if (users.length === 0) return json(generic);

    const user = users[0];
    if (!user.email) return json({ ok: true, message: "Ask a manager to reset your password." });

    // Create reset token (30 min expiry)
    const token = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await sql`
      INSERT INTO app.password_resets (user_id, token, expires_at)
      VALUES (${user.user_id}, ${token}, ${expiresAt})
    `;

    // Build link and send email
    const base = (env.APP_BASE_URL as string) || new URL(request.url).origin;
    const link = `${base}/reset.html?token=${encodeURIComponent(token)}`;

    const subject = "Resell Pro: Reset your password";
    const text =
`We received a request to reset your password.
If you made this request, open the link below within 30 minutes:

${link}

If you did not request this, you can ignore this email.`;
    const html =
`<p>We received a request to reset your password.</p>
<p>If you made this request, click the link below within 30 minutes:</p>
<p><a href="${link}">${link}</a></p>
<p>If you did not request this, you can ignore this email.</p>`;

    await sendMail(env, user.email!, subject, text, html);

    return json(generic);
  } catch (err) {
    return json({ error: "Could not start reset." }, 500);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sendMail(
  env: Record<string, unknown>,
  to: string,
  subject: string,
  text: string,
  html?: string
) {
  const fromEmail = (env.MAIL_FROM as string) || "no-reply@localhost";
  const fromName = (env.MAIL_FROM_NAME as string) || "Resell Pro";

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: fromEmail, name: fromName },
    subject,
    content: [
      { type: "text/plain", value: text },
      ...(html ? [{ type: "text/html", value: html }] : []),
    ],
  };

  const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Log details so we can debug in Pages Function logs
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("MailChannels send failed", {
      status: res.status,
      statusText: res.statusText,
      bodySnippet: body.slice(0, 500),
      to,
      fromEmail,
    });
    throw new Error(`Mail send failed: ${res.status} ${res.statusText}`);
  } else {
    console.log("MailChannels send ok", { to, subject });
  }
}
