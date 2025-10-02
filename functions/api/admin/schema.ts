// functions/api/admin/schema.ts
import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  // Simple header check to protect the endpoint
  const key = request.headers.get("x-admin-key");
  if (!key || key !== env.ADMIN_SCHEMA_KEY) return new Response("forbidden", { status: 403 });

  const sql = neon(env.DATABASE_URL);

  const [tables, columns, pks, fks, indexes] = await Promise.all([
    sql`SELECT table_name
        FROM information_schema.tables
        WHERE table_schema='app' AND table_type='BASE TABLE'
        ORDER BY table_name`,
    sql`SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position
        FROM information_schema.columns
        WHERE table_schema='app'
        ORDER BY table_name, ordinal_position`,
    sql`SELECT tc.table_name, kcu.column_name, tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_schema='app' AND tc.constraint_type='PRIMARY KEY'
        ORDER BY tc.table_name, kcu.ordinal_position`,
    sql`SELECT tc.table_name, kcu.column_name,
               ccu.table_name AS foreign_table, ccu.column_name AS foreign_column,
               tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_schema='app' AND tc.constraint_type='FOREIGN KEY'
        ORDER BY tc.table_name, kcu.ordinal_position`,
    sql`SELECT tablename AS table_name, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname='app'
        ORDER BY tablename, indexname`
  ]);

  return json({ tables, columns, primary_keys: pks, foreign_keys: fks, indexes });
};
