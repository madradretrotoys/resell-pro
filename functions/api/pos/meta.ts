// /api/pos/meta
// Central POS metadata: tax rate + Valor config.
// Safe to extend later with other POS flags.

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { env, request } = ctx;

  // If you later store tenant-specific tax in Neon, read tenant here:
  const tenantId = request.headers.get("x-tenant-id") || null;

  // For now we keep it simple: return a server-provided or default tax rate.
  // (Matches your current UI default of 8.0% so behavior doesn't change today.)
  const taxRateDefault = Number(env.DEFAULT_TAX_RATE ?? 0.080);

  // Valor UI timing defaults — tunable via env if you want.
  const valorAckMs = Number(env.VALOR_ACK_TIMEOUT_MS ?? 12000);
  const valorPollEveryMs = Number(env.VALOR_POLL_INTERVAL_MS ?? 1200);
  const valorPollTimeoutMs = Number(env.VALOR_POLL_TIMEOUT_MS ?? 40000);

  return json({
    // Feature toggles
    preview_enabled: false,

    // Tax (server-driven; can be swapped to Neon later)
    tax_rate: taxRateDefault,

    // Valor config for the POS UI
    valor_enabled: true,
    valor_environment: String(env.VALOR_ENVIRONMENT ?? "production"),
    valor_ack_timeout_ms: valorAckMs,
    valor_poll_interval_ms: valorPollEveryMs,
    valor_poll_timeout_ms: valorPollTimeoutMs,
  });
};

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
