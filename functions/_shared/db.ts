import { neon } from "@neondatabase/serverless";

// Returns a tagged-template SQL fn compatible with: const sql = getSql(env); await sql`SELECT ...`
export function getSql(env: { DATABASE_URL?: string }) {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing");
  const sql = neon(url);
  // Cast keeps the same call style your code already uses: sql/*sql*/`...`
  return sql as unknown as <T = any>(
    strings: TemplateStringsArray,
    ...values: any[]
  ) => Promise<T[]>;
}
