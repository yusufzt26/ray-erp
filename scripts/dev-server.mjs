// Local test server without the Netlify CLI: a throwaway Postgres (from
// @netlify/database-dev) with the migrations applied, in-memory PDF storage,
// static files from public/ and /api/* sent to the real function.
//   node scripts/dev-server.mjs   ->  http://localhost:8888
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import pg from "pg";
import { NetlifyDB } from "@netlify/database-dev";

const db = new NetlifyDB();
const url = await db.start();
await db.applyMigrations("./netlify/database/migrations");
globalThis.__TEST_POOL = new pg.Pool({ connectionString: url, max: 4 });
const blobs = new Map();
globalThis.__TEST_BLOBS = {
  set: async (k, v) => blobs.set(k, v),
  get: async (k) => blobs.get(k) ?? null,
  delete: async (k) => blobs.delete(k),
};
const { default: handler } = await import("../netlify/functions/api.mts");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const port = Number(process.env.PORT || 8888);
createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${port}`);
  if (u.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await handler(new Request(u, { method: req.method, headers: req.headers, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const file = normalize(join("public", u.pathname === "/" ? "index.html" : u.pathname));
  if (!file.startsWith("public")) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(port, () => console.log(`ERP dev server on http://localhost:${port}`));
