import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";

type Pool = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>; connect: () => Promise<any> };

let pool: Pool | null = null;

/** Postgres pool. Tests can inject one with globalThis.__TEST_POOL. */
export function getPool(): Pool {
  const g = globalThis as any;
  if (g.__TEST_POOL) return g.__TEST_POOL;
  if (!pool) pool = getDatabase().pool as unknown as Pool;
  return pool;
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/** Run several statements on one connection inside a transaction. */
export async function tx<T>(fn: (query: (t: string, p?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const query = async (t: string, p: unknown[] = []) => (await client.query(t, p)).rows;
  try {
    await client.query("BEGIN");
    const out = await fn(query);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Next running code like FG-00001. Atomic, safe with many users at once. */
export async function nextCode(query: (t: string, p?: unknown[]) => Promise<any[]>, counter: string, prefix: string, width = 5) {
  const rows = await query(
    "INSERT INTO counters (name, value) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value",
    [counter],
  );
  return `${prefix}-${String(rows[0].value).padStart(width, "0")}`;
}

/** Store for uploaded PDFs. Tests can inject one with globalThis.__TEST_BLOBS. */
export function pdfStore(): { set: Function; get: Function; delete: Function } {
  const g = globalThis as any;
  if (g.__TEST_BLOBS) return g.__TEST_BLOBS;
  return getStore({ name: "pdf-uploads", consistency: "strong" }) as any;
}
