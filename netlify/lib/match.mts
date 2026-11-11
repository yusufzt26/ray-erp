// Match what was read from a PDF against the masters.
import { q } from "./db.mts";

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Similarity 0..1 (Dice coefficient on character pairs). */
function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pairs = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
    return m;
  };
  const pa = pairs(a), pb = pairs(b);
  let inter = 0;
  for (const [k, v] of pa) inter += Math.min(v, pb.get(k) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

export async function matchParty(table: "customers" | "vendors", text: string, gstin: string, partyName: string) {
  if (gstin) {
    const rows = await q(`SELECT id, name, gstin FROM ${table} WHERE upper(gstin) = $1`, [gstin.toUpperCase()]);
    if (rows[0]) return { party: rows[0], how: "GSTIN" };
  }
  const low = norm(text) + " " + norm(partyName);
  let best: any = null, bestScore = 0;
  for (const row of await q(`SELECT id, name, gstin FROM ${table} WHERE active = 1`)) {
    const name = norm(row.name);
    if (!name) continue;
    const core = name.replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|india)\b\.?/g, "").replace(/[\s.,]+$/, "").trim();
    if (low.includes(name) || (core.length >= 4 && low.includes(core))) {
      if (name.length > bestScore) { best = row; bestScore = name.length; }
    }
  }
  return best ? { party: best, how: "name" } : { party: null, how: null };
}

export async function matchProducts(lines: any[]) {
  const products = await q("SELECT id, code, name, customer_part_no, drawing_no FROM products WHERE active = 1");
  return lines.map((line) => {
    const part = norm(line.party_part_no);
    const desc = norm(line.description);
    if (part) {
      const p = products.find((p) => [p.customer_part_no, p.code, p.drawing_no].some((v) => norm(v) === part));
      if (p) return p.id;
    }
    if (desc) {
      const byPart = products.find((p) => norm(p.customer_part_no) && desc.includes(norm(p.customer_part_no)));
      if (byPart) return byPart.id;
      let best: any = null, bestR = 0;
      for (const p of products) {
        const r = similarity(desc, norm(p.name));
        if (r > bestR) { best = p; bestR = r; }
      }
      if (best && bestR >= 0.85) return best.id;
    }
    return null;
  });
}
