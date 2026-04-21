import { neon } from "@neondatabase/serverless";

type Sql = ReturnType<typeof neon>;

function parseDrawerNum(input: string | null | undefined): number | null {
  if (!input) return null;
  const n = Number(String(input).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function parseDrawerNumFromRow(row: any): number | null {
  const codeNum = String(row?.drawer_code || "").match(/^D(\d+)$/i)?.[1];
  const nameNum = String(row?.drawer_name || "").match(/drawer\s+(\d+)/i)?.[1];
  const raw = Number(codeNum || nameNum || 0);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.trunc(raw);
}

export async function resolveLegacyDrawer(sql: Sql, args: {
  tenant_id: string;
  drawer?: string | null;
  drawer_id?: string | null;
}) {
  const direct = parseDrawerNum(args.drawer);
  if (direct) return { drawer: String(direct), drawer_id: null as string | null };

  const drawer_id = String(args.drawer_id || "").trim();
  if (drawer_id) {
    const rows = await sql/*sql*/`
      SELECT drawer_id, drawer_name, drawer_code
      FROM app.tenant_drawers
      WHERE tenant_id = ${args.tenant_id}::uuid
        AND drawer_id = ${drawer_id}::uuid
      LIMIT 1
    `;
    const row = rows?.[0];
    if (!row) throw new Error("drawer_not_found");
    const resolved = parseDrawerNumFromRow(row) || 1;
    return { drawer: String(resolved), drawer_id: String(row.drawer_id) };
  }

  return { drawer: "1", drawer_id: null as string | null };
}
