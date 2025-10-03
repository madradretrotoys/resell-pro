import { neon } from "@neondatabase/serverless";

type Body = { email?: string };

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const { email } = (await request.json().catch(() => ({}))) as Body;
    if (!email) return json({ error: "Email required." }, 400);

    const sql = neon(env.DATABASE_URL as string);

    const rows = await sql<{ login_id: string }[]>
      `SELECT login_id FROM app.users WHERE email = ${email} LIMIT 1`;

    const generic = { ok: true, message: "If that email exists, we sent the User ID." };

    if (rows.length === 0) return json(generic);

    const loginId = rows[0].login_id;

    const subject = "Resell Pro: Your User ID";
    const text =
`You requested your Resell Pro User ID.

User ID: ${loginId}

If you didn't make this request, you can ignore this email.`;
    const html =
`<p>You requested your Resell Pro User ID.</p>
<p><strong>User ID:</strong> ${escapeHtml(loginId)}</p>
<p>If you didn't make this request, you can ignore this email.</p>`;

    await sendMail(env, email, subject, text, html);
    return json(generic);
  } catch (err) {
    return json({ error: "Could not send email." }, 500);
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

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
