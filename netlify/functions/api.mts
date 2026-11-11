import type { Config, Context } from "@netlify/functions";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { CONVERT, DOC_TYPES, LEVELS, MASTERS, MODULES, PRODUCT_CATEGORIES, ROLES, coerce } from "../../public/js/fields.js";
import { clearCookie, makeSessionCookie, readSession } from "../lib/auth.mts";
import { matchParty, matchProducts } from "../lib/match.mts";
import { nextCode, one, pdfStore, q, tx } from "../lib/db.mts";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };

type User = { id: number; username: string; full_name: string; role: string; password_hash: string; active: number };
type Ctx = { req: Request; user: User | null; perms: Record<string, string>; params: Record<string, string>; body: any };

async function permissionsFor(role: string) {
  if (role === "Admin") return Object.fromEntries(Object.keys(MODULES).map((m) => [m, "edit"]));
  const rows = await q("SELECT module, level FROM role_permissions WHERE role = $1", [role]);
  const out: Record<string, string> = Object.fromEntries(Object.keys(MODULES).map((m) => [m, "none"]));
  for (const r of rows) out[r.module] = r.level;
  return out;
}

function require(c: Ctx, module: string, level: "view" | "edit" = "view") {
  if (!c.user) fail(401, "Please log in.");
  if (LEVELS.indexOf(c.perms[module] || "none") < LEVELS.indexOf(level))
    fail(403, "Your role does not have access to this. Ask the Admin if you need it.");
}

const masterOf = (name: string) => (MASTERS as any)[name] || fail(404, "Unknown list");
const docTypeOf = (name: string) => (DOC_TYPES as any)[name] || fail(404, "Unknown document type");
const num = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
};
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const isoDate = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null);

// ---------------------------------------------------------------- masters

function cleanMaster(master: string, input: any, partial = false) {
  const m = masterOf(master);
  const values: Record<string, any> = {};
  const errors: string[] = [];
  for (const f of m.fields) {
    if (partial && !(f.key in input)) continue;
    try {
      values[f.key] = coerce(f, input[f.key]);
    } catch (e: any) {
      errors.push(e.message);
    }
    if (f.required && !values[f.key] && !partial) errors.push(`${f.label} is required.`);
  }
  return { values, errors };
}

async function insertMaster(query: any, master: string, values: Record<string, any>) {
  const m = masterOf(master);
  const code = master === "products"
    ? await nextCode(query, `product_${values.category || "FG"}`, values.category || "FG")
    : await nextCode(query, m.counter, m.prefix, 4);
  const keys = m.fields.map((f: any) => f.key);
  const rows = await query(
    `INSERT INTO ${m.table} (code, ${keys.join(", ")}) VALUES ($1, ${keys.map((_: any, i: number) => `$${i + 2}`).join(", ")}) RETURNING id, code`,
    [code, ...keys.map((k: string) => values[k] ?? null)],
  );
  return rows[0] as { id: number; code: string };
}

async function updateMaster(query: any, master: string, id: number, values: Record<string, any>) {
  const m = masterOf(master);
  const keys = Object.keys(values).filter((k) => m.fields.some((f: any) => f.key === k));
  if (!keys.length) return;
  await query(`UPDATE ${m.table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")} WHERE id = $${keys.length + 1}`,
    [...keys.map((k) => values[k]), id]);
}

const routes: [string, RegExp, (c: Ctx) => Promise<Response>][] = [];
const route = (method: string, path: string, fn: (c: Ctx) => Promise<Response>) =>
  routes.push([method, new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn]);

// ---------------------------------------------------------------- auth
route("POST", "/api/login", async (c) => {
  const u = await one<User>("SELECT * FROM users WHERE lower(username) = $1 AND active = 1", [str(c.body.username).toLowerCase()]);
  if (!u || !(await bcrypt.compare(String(c.body.password || ""), u.password_hash))) fail(401, "Wrong username or password.");
  const secure = new URL(c.req.url).protocol === "https:";
  return json({ ok: true }, 200, { "set-cookie": await makeSessionCookie(u!.id, secure) });
});

route("POST", "/api/logout", async () => json({ ok: true }, 200, { "set-cookie": clearCookie() }));

route("GET", "/api/me", async (c) => {
  if (!c.user) return json({ user: null });
  const settings = Object.fromEntries((await q("SELECT key, value FROM settings WHERE key <> 'session_secret'")).map((r) => [r.key, r.value]));
  const defaultPw = c.user.username === "admin" && (await bcrypt.compare("admin123", c.user.password_hash));
  const { password_hash, ...user } = c.user;
  return json({ user, perms: c.perms, settings, defaultPw });
});

route("POST", "/api/password", async (c) => {
  if (!c.user) fail(401, "Please log in.");
  if (!(await bcrypt.compare(String(c.body.current || ""), c.user!.password_hash))) fail(400, "Current password is wrong.");
  if (String(c.body.new || "").length < 6) fail(400, "New password must be at least 6 characters.");
  await q("UPDATE users SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(String(c.body.new), 10), c.user!.id]);
  return json({ ok: true });
});

// ---------------------------------------------------------------- dashboard
route("GET", "/api/dashboard", async (c) => {
  if (!c.user) fail(401, "Please log in.");
  const counts: any[] = [];
  for (const [key, m] of Object.entries(MASTERS) as any) {
    if (c.perms[key] !== "none")
      counts.push({ label: m.title, n: Number((await one(`SELECT COUNT(*) AS n FROM ${m.table} WHERE active = 1`)).n), href: `#/m/${key}` });
  }
  const allowed = Object.keys(DOC_TYPES).filter((k) => c.perms[k] !== "none");
  for (const k of allowed)
    counts.push({ label: (DOC_TYPES as any)[k].title, n: Number((await one("SELECT COUNT(*) AS n FROM documents WHERE doc_type = $1", [k])).n), href: `#/d/${k}` });
  if (c.perms.sales_invoice !== "none")
    counts.push({ label: "Sales Invoices", n: Number((await one("SELECT COUNT(*) AS n FROM invoices")).n), href: "#/invoices" });
  if (c.perms.accounts && c.perms.accounts !== "none") {
    const sum = (rows: any[]) => Math.round(rows.reduce((t, r) => t + Math.max(0, Number(r.balance)), 0));
    counts.push({ label: "To collect (₹)", n: sum(await q(RECV_SQL)).toLocaleString("en-IN"), href: "#/accounts" });
    counts.push({ label: "To pay (₹)", n: sum(await q(PAY_SQL)).toLocaleString("en-IN"), href: "#/accounts?tab=pay" });
  }
  const recent = allowed.length
    ? await q("SELECT id, doc_type, ref_no, doc_no, to_char(doc_date, 'YYYY-MM-DD') AS doc_date, party_name, total_amount, status FROM documents WHERE doc_type = ANY($1) ORDER BY id DESC LIMIT 10", [allowed])
    : [];
  return json({ counts, recent });
});

// ---------------------------------------------------------------- masters
route("GET", "/api/m/:master", async (c) => {
  const m = masterOf(c.params.master);
  require(c, c.params.master);
  const url = new URL(c.req.url);
  const qs = str(url.searchParams.get("q"));
  const show = url.searchParams.get("show") || "active";
  const flt = str(url.searchParams.get("flt"));
  const where: string[] = [], params: unknown[] = [];
  if (show === "active") where.push("active = 1");
  if (qs) {
    const cols = ["code", "name", ...m.fields.filter((f: any) => f.inList && f.type === "text").map((f: any) => f.key)];
    params.push(`%${qs}%`);
    where.push("(" + cols.map((col) => `${col} ILIKE $${params.length}`).join(" OR ") + ")");
  }
  if (c.params.master === "products" && (flt === "sellable" || flt === "purchasable")) where.push(`${flt} = 1`);
  if (c.params.master === "products" && (PRODUCT_CATEGORIES as any)[flt]) { params.push(flt); where.push(`category = $${params.length}`); }
  const rows = await q(`SELECT * FROM ${m.table}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY code`, params);
  return json({ rows });
});

route("GET", "/api/m/:master/:id", async (c) => {
  const m = masterOf(c.params.master);
  require(c, c.params.master);
  const row = await one(`SELECT * FROM ${m.table} WHERE id = $1`, [Number(c.params.id)]);
  if (!row) fail(404, "Not found");
  return json({ row });
});

route("POST", "/api/m/:master", async (c) => {
  const master = c.params.master;
  const m = masterOf(master);
  require(c, master, "edit");
  const { values, errors } = cleanMaster(master, c.body);
  if (master === "products" && !(values.sellable || values.purchasable)) errors.push("Tick Sellable, Purchasable, or both.");
  if (errors.length) return json({ errors }, 400);
  if (!c.body.confirm_dup) {
    const dup = await one(`SELECT code FROM ${m.table} WHERE lower(name) = $1`, [values.name.toLowerCase()]);
    if (dup) return json({ errors: [`'${values.name}' already exists as ${dup.code}. Tick 'Save anyway' if it is really a different one.`], dup: true }, 400);
  }
  const created = await tx((query) => insertMaster(query, master, values));
  return json(created, 201);
});

route("PUT", "/api/m/:master/:id", async (c) => {
  const master = c.params.master;
  const m = masterOf(master);
  require(c, master, "edit");
  const id = Number(c.params.id);
  const row = await one(`SELECT * FROM ${m.table} WHERE id = $1`, [id]);
  if (!row) fail(404, "Not found");
  const { values, errors } = cleanMaster(master, c.body);
  if (master === "products") {
    if (!(values.sellable || values.purchasable)) errors.push("Tick Sellable, Purchasable, or both.");
    values.category = row.category; // item code prefix is fixed once created
  }
  if (errors.length) return json({ errors }, 400);
  if (!c.body.confirm_dup) {
    const dup = await one(`SELECT code FROM ${m.table} WHERE lower(name) = $1 AND id <> $2`, [values.name.toLowerCase(), id]);
    if (dup) return json({ errors: [`'${values.name}' already exists as ${dup.code}. Tick 'Save anyway' if it is really a different one.`], dup: true }, 400);
  }
  await updateMaster(q, master, id, values);
  return json({ id, code: row.code });
});

route("DELETE", "/api/m/:master/:id", async (c) => {
  const master = c.params.master;
  const m = masterOf(master);
  require(c, master, "edit");
  const id = Number(c.params.id);
  const used = master === "products"
    ? await one("SELECT 1 FROM document_lines WHERE product_id = $1 LIMIT 1", [id])
    : await one("SELECT 1 FROM documents WHERE doc_type = $1 AND party_id = $2 LIMIT 1", [master === "customers" ? "customer_po" : "vendor_invoice", id]);
  if (used) {
    await q(`UPDATE ${m.table} SET active = 0 WHERE id = $1`, [id]);
    return json({ message: "This record is used in documents, so it was made inactive instead of deleted." });
  }
  await q(`DELETE FROM ${m.table} WHERE id = $1`, [id]);
  return json({ message: `${m.singular} deleted.` });
});

// rows: [{ code?, name, ... }] already mapped to field keys by the browser (from .xlsx or .csv)
route("POST", "/api/m/:master/import", async (c) => {
  const master = c.params.master;
  const m = masterOf(master);
  require(c, master, "edit");
  const rows: any[] = Array.isArray(c.body.rows) ? c.body.rows.slice(0, 5000) : [];
  const added: [string, string][] = [];
  const errors: [number, string][] = [];
  let updated = 0;
  await tx(async (query) => {
    for (const row of rows) {
      const n = row.__row ?? 0;
      const { values, errors: errs } = cleanMaster(master, row, true);
      const code = str(row.code);
      let existing: any = null;
      if (code) {
        existing = (await query(`SELECT * FROM ${m.table} WHERE code = $1`, [code]))[0];
        if (!existing) { errors.push([n, `Code ${code} not found. Leave Code blank to add a new record.`]); continue; }
      } else if (!values.name) errs.push("Name is empty");
      if (errs.length) { errors.push([n, errs.join("; ")]); continue; }
      if (existing) {
        if (master === "products") delete values.category;
        if ("active" in row && str(row.active) === "") delete values.active;
        await updateMaster(query, master, existing.id, values);
        updated++;
      } else {
        if (!("active" in row) || str(row.active) === "") values.active = 1;
        if (master === "products") {
          values.category ||= "FG";
          values.uom ||= "NOS";
          if (!(values.sellable || values.purchasable)) {
            values.sellable = ["FG", "SA"].includes(values.category) ? 1 : 0;
            values.purchasable = values.sellable ? 0 : 1;
          }
        }
        const created = await insertMaster(query, master, values);
        added.push([created.code, values.name]);
      }
    }
  });
  return json({ added, updated, errors });
});

// ---------------------------------------------------------------- documents
const DOC_COLS = "id, doc_type, parent_id, ref_no, doc_no, to_char(doc_date, 'YYYY-MM-DD') AS doc_date, party_id, party_name, party_gstin, to_char(delivery_date, 'YYYY-MM-DD') AS delivery_date, subtotal, tax_amount, total_amount, notes, pdf_file, status, eway, created_at";

route("GET", "/api/d/:type", async (c) => {
  docTypeOf(c.params.type);
  require(c, c.params.type);
  const qs = str(new URL(c.req.url).searchParams.get("q"));
  const params: unknown[] = [c.params.type];
  let sql = `SELECT ${DOC_COLS} FROM documents WHERE doc_type = $1`;
  if (qs) { params.push(`%${qs}%`); sql += " AND (doc_no ILIKE $2 OR ref_no ILIKE $2 OR party_name ILIKE $2)"; }
  return json({ rows: await q(sql + " ORDER BY id DESC", params) });
});

route("GET", "/api/d/:type/lines", async (c) => {
  docTypeOf(c.params.type);
  require(c, c.params.type);
  const rows = await q(`SELECT d.ref_no, d.doc_no, to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date, d.party_name, d.party_gstin, d.status,
      l.line_no, p.code AS item_code, l.party_part_no, l.description, l.hsn, l.qty, l.uom, l.rate, l.amount, d.total_amount
    FROM documents d LEFT JOIN document_lines l ON l.document_id = d.id LEFT JOIN products p ON p.id = l.product_id
    WHERE d.doc_type = $1 ORDER BY d.id, l.line_no`, [c.params.type]);
  return json({ rows });
});

route("GET", "/api/d/:type/options", async (c) => {
  const d = docTypeOf(c.params.type);
  require(c, c.params.type);
  const parties = await q(`SELECT id, code, name, gstin FROM ${d.partyTable} WHERE active = 1 ORDER BY name`);
  const products = await q(`SELECT id, code, name, customer_part_no, sellable, purchasable, uom, hsn, sale_rate, purchase_rate
    FROM products WHERE active = 1 ORDER BY (CASE WHEN ${d.productFlag} = 1 THEN 0 ELSE 1 END), code`);
  return json({ parties, products });
});

route("GET", "/api/d/:type/:id", async (c) => {
  docTypeOf(c.params.type);
  require(c, c.params.type);
  const doc = await one(`SELECT ${DOC_COLS} FROM documents WHERE id = $1 AND doc_type = $2`, [Number(c.params.id), c.params.type]);
  if (!doc) fail(404, "Not found");
  const lines = await q("SELECT * FROM document_lines WHERE document_id = $1 ORDER BY line_no", [doc.id]);
  return json({ doc, lines });
});

// Browser sends what it read from the PDF; we match it to the masters.
route("POST", "/api/d/:type/match", async (c) => {
  const d = docTypeOf(c.params.type);
  require(c, c.params.type, "edit");
  const { party, how } = await matchParty(d.partyTable, str(c.body.text).slice(0, 200000), str(c.body.party_gstin), str(c.body.party_name));
  const productIds = await matchProducts(Array.isArray(c.body.lines) ? c.body.lines.slice(0, 500) : []);
  return json({ party, how, productIds });
});

route("POST", "/api/d/:type/save", async (c) => {
  const type = c.params.type;
  const d = docTypeOf(type);
  require(c, type, "edit");
  const b = c.body;
  const did = num(b.id);
  const pdfFile = str(b.pdf_file);
  if (pdfFile && !/^[0-9a-f-]{36}\.pdf$/.test(pdfFile)) fail(400, "Bad file reference");
  const messages: string[] = [];
  const result = await tx(async (query) => {
    let partyId = num(b.party_id);
    let partyName = str(b.party_name);
    let partyGstin = str(b.party_gstin).toUpperCase();
    if (!partyId && b.create_party && partyName) {
      const created = await insertMaster(query, d.partyMaster, { name: partyName, gstin: partyGstin || null, active: 1 });
      partyId = created.id;
      messages.push(`New ${d.partyLabel.toLowerCase()} ${created.code} - ${partyName} added to the master.`);
    }
    if (partyId) {
      const p = (await query(`SELECT name, gstin FROM ${d.partyTable} WHERE id = $1`, [partyId]))[0];
      if (p) { partyName = p.name; partyGstin ||= p.gstin || ""; } else partyId = null;
    }
    if ((!str(b.doc_no) && !d.own) || !partyName) fail(400, `${d.own ? "" : d.noLabel + " and "}${d.partyLabel} ${d.own ? "is" : "are"} required.`);

    const lines: any[] = [];
    for (const l of (Array.isArray(b.lines) ? b.lines : []).slice(0, 500)) {
      const desc = str(l.description), part = str(l.party_part_no);
      const qty = num(l.qty), rate = num(l.rate);
      let amount = num(l.amount);
      let pid = num(l.product_id);
      if (!(desc || part || pid) && !qty) continue;
      if (amount === null && qty !== null && rate !== null) amount = Math.round(qty * rate * 100) / 100;
      if (!pid && l.create && (desc || part)) {
        const cat = (PRODUCT_CATEGORIES as any)[l.category] ? l.category : type === "customer_po" ? "FG" : "RM";
        const values: any = {
          name: desc || part, category: cat, customer_part_no: part || null, hsn: str(l.hsn) || null,
          uom: (str(l.uom) || "NOS").toUpperCase(), active: 1,
          sellable: type === "customer_po" ? 1 : 0, purchasable: type === "vendor_invoice" ? 1 : 0,
          [type === "customer_po" ? "sale_rate" : "purchase_rate"]: rate,
        };
        const created = await insertMaster(query, "products", values);
        pid = created.id;
        messages.push(`New product ${created.code} - ${values.name} added to the product list.`);
      }
      lines.push([pid, part, desc, str(l.hsn), qty, str(l.uom).toUpperCase(), rate, amount]);
    }
    const subtotal = Math.round(lines.reduce((s, l) => s + (l[7] || 0), 0) * 100) / 100;
    const total = num(b.total_amount) ?? subtotal;
    const header = {
      doc_no: str(b.doc_no), doc_date: isoDate(b.doc_date), party_id: partyId, party_name: partyName, party_gstin: partyGstin,
      delivery_date: isoDate(b.delivery_date), subtotal, tax_amount: total ? Math.round((total - subtotal) * 100) / 100 : null,
      total_amount: total, notes: str(b.notes), status: d.statuses.includes(b.status) ? b.status : d.statuses[0],
    };
    if (!did && num(b.parent_id)) (header as any).parent_id = num(b.parent_id);
    const dup = header.doc_no ? (await query("SELECT ref_no FROM documents WHERE doc_type = $1 AND doc_no = $2 AND party_name = $3 AND id <> $4",
      [type, header.doc_no, partyName, did || 0]))[0] : null;
    if (dup) messages.push(`Note: ${d.noLabel} ${header.doc_no} from ${partyName} was already entered as ${dup.ref_no}.`);
    const keys = Object.keys(header);
    let id = did;
    let refNo: string;
    if (did) {
      const existing = (await query("SELECT ref_no FROM documents WHERE id = $1 AND doc_type = $2", [did, type]))[0];
      if (!existing) fail(404, "Not found");
      refNo = existing.ref_no;
      await query(`UPDATE documents SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")} WHERE id = $${keys.length + 1}`,
        [...Object.values(header), did]);
      await query("DELETE FROM document_lines WHERE document_id = $1", [did]);
    } else {
      refNo = await nextCode(query, `doc_${type}`, d.prefix);
      if (!header.doc_no) header.doc_no = refNo;
      const all: any = { ...header, doc_type: type, ref_no: refNo, pdf_file: pdfFile || null, created_by: c.user!.id };
      const ks = Object.keys(all);
      id = (await query(`INSERT INTO documents (${ks.join(", ")}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        Object.values(all)))[0].id;
    }
    for (let i = 0; i < lines.length; i++)
      await query(`INSERT INTO document_lines (document_id, line_no, product_id, party_part_no, description, hsn, qty, uom, rate, amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [id, i + 1, ...lines[i]]);
    const parentId = (await query("SELECT parent_id FROM documents WHERE id = $1", [id]))[0]?.parent_id;
    if (parentId) await refreshStatus(query, parentId);
    return { id, ref_no: refNo };
  });
  return json({ ...result, messages });
});

route("DELETE", "/api/d/:type/:id", async (c) => {
  docTypeOf(c.params.type);
  require(c, c.params.type, "edit");
  await q("DELETE FROM documents WHERE id = $1 AND doc_type = $2", [Number(c.params.id), c.params.type]);
  return json({ message: "Deleted." });
});

// PDF files: raw body upload, stored in Netlify Blobs
route("POST", "/api/pdf/:type", async (c) => {
  docTypeOf(c.params.type);
  require(c, c.params.type, "edit");
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) fail(400, "Empty file");
  if (new TextDecoder().decode(buf.slice(0, 5)) !== "%PDF-") fail(400, "This is not a PDF file.");
  const key = `${randomUUID()}.pdf`;
  await pdfStore().set(key, buf, { metadata: { type: c.params.type, by: c.user!.id } });
  return json({ key }, 201);
});

route("GET", "/api/pdf/:type/:key", async (c) => {
  docTypeOf(c.params.type);
  require(c, c.params.type);
  if (!/^[0-9a-f-]{36}\.pdf$/.test(c.params.key)) fail(404, "Not found");
  const data = await pdfStore().get(c.params.key, { type: "arrayBuffer" });
  if (!data) fail(404, "Not found");
  return new Response(data, { headers: { "content-type": "application/pdf", "cache-control": "private, max-age=3600" } });
});

// ---------------------------------------------------------------- admin
route("GET", "/api/users", async (c) => {
  require(c, "users");
  return json({ rows: await q("SELECT id, username, full_name, role, email, phone, active FROM users ORDER BY active DESC, role, username") });
});

async function saveUser(c: Ctx, uid: number | null) {
  require(c, "users", "edit");
  const b = c.body;
  const v = {
    username: str(b.username).toLowerCase(), full_name: str(b.full_name), role: str(b.role),
    email: str(b.email) || null, phone: str(b.phone) || null, active: b.active ? 1 : 0,
  };
  const pw = String(b.password || "");
  if (!/^[a-z0-9._-]{3,30}$/.test(v.username)) fail(400, "Username: 3-30 letters, numbers, dot, dash or underscore.");
  if (!v.full_name) fail(400, "Full name is required.");
  if (!ROLES.includes(v.role)) fail(400, "Pick a role.");
  if ((!uid || pw) && pw.length < 6) fail(400, "Password must be at least 6 characters.");
  if (await one("SELECT 1 FROM users WHERE username = $1 AND id <> $2", [v.username, uid || 0])) fail(400, "That username is taken.");
  if (uid === c.user!.id && (v.role !== "Admin" || !v.active)) fail(400, "You cannot remove your own Admin access.");
  if (uid) {
    await q("UPDATE users SET username=$1, full_name=$2, role=$3, email=$4, phone=$5, active=$6 WHERE id=$7",
      [v.username, v.full_name, v.role, v.email, v.phone, v.active, uid]);
    if (pw) await q("UPDATE users SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(pw, 10), uid]);
    return json({ id: uid });
  }
  const row = await one("INSERT INTO users (username, full_name, role, email, phone, active, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [v.username, v.full_name, v.role, v.email, v.phone, v.active, await bcrypt.hash(pw, 10)]);
  return json({ id: row.id }, 201);
}
route("POST", "/api/users", (c) => saveUser(c, null));
route("PUT", "/api/users/:id", (c) => saveUser(c, Number(c.params.id)));

route("GET", "/api/permissions", async (c) => {
  require(c, "users");
  return json({ rows: await q("SELECT role, module, level FROM role_permissions") });
});

route("PUT", "/api/permissions", async (c) => {
  require(c, "users", "edit");
  await tx(async (query) => {
    for (const [k, level] of Object.entries(c.body.perms || {})) {
      const [role, module] = k.split(":");
      if (role === "Admin" || !ROLES.includes(role) || !(module in MODULES) || !LEVELS.includes(level as string)) continue;
      await query("INSERT INTO role_permissions (role, module, level) VALUES ($1,$2,$3) ON CONFLICT (role, module) DO UPDATE SET level = EXCLUDED.level",
        [role, module, level]);
    }
  });
  return json({ ok: true });
});

const SETTING_KEYS = ["company_name", "company_gstin", "company_pan", "company_state", "company_gst_wef", "company_address",
  "company_email", "company_mobile", "company_tagline", "invoice_prefix", "invoice_terms", "bank_details", "invoice_declaration"];
route("PUT", "/api/settings", async (c) => {
  if (c.user?.role !== "Admin") fail(403, "Only Admin can change company settings.");
  for (const k of SETTING_KEYS) {
    if (!(k in c.body)) continue;
    let v = str(c.body[k]);
    if (k === "company_gstin" || k === "company_pan") v = v.toUpperCase();
    await q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, v]);
  }
  return json({ ok: true });
});

// ---------------------------------------------------------------- sales invoices
const INV_COLS = `id, inv_no, to_char(inv_date, 'YYYY-MM-DD') AS inv_date, customer_id, customer_po_id, po_no,
  to_char(po_date, 'YYYY-MM-DD') AS po_date, supplier_code, bill_to, ship_to, gstin, pan, tax_type, gst_rate,
  subtotal, cgst, sgst, igst, total, delivery_condition, payment_terms, packing, status, eway, created_at`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Financial year label: Apr 2026 - Mar 2027 -> "26". */
const fyOf = (iso: string) => { const [y, m] = iso.split("-").map(Number); return String((m >= 4 ? y : y - 1) % 100).padStart(2, "0"); };

async function nextInvoiceNo(query: any, isoDay: string) {
  const fy = fyOf(isoDay);
  const prefix = (await query("SELECT value FROM settings WHERE key = 'invoice_prefix'"))[0]?.value || "R";
  const rows = await query("INSERT INTO counters (name, value) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value", [`invoice_${fy}`]);
  return `${prefix}/${fy}-${String(rows[0].value).padStart(3, "0")}`;
}

route("GET", "/api/invoices", async (c) => {
  require(c, "sales_invoice");
  const qs = str(new URL(c.req.url).searchParams.get("q"));
  const params: unknown[] = [];
  let sql = `SELECT i.id, i.inv_no, to_char(i.inv_date, 'YYYY-MM-DD') AS inv_date, i.po_no, i.total, i.status, cu.name AS customer
    FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id`;
  if (qs) { params.push(`%${qs}%`); sql += " WHERE i.inv_no ILIKE $1 OR i.po_no ILIKE $1 OR cu.name ILIKE $1"; }
  const rows = await q(sql + " ORDER BY i.id DESC", params);
  if (c.perms.accounts !== "none") {
    const st = Object.fromEntries((await billStatus("in")).rows.map((r) => [r.id, r]));
    for (const r of rows) if (st[r.id]) { r.pay_status = st[r.id].pay_status; r.balance = st[r.id].balance; }
  }
  return json({ rows });
});

route("GET", "/api/invoices/options", async (c) => {
  require(c, "sales_invoice");
  const customers = await q("SELECT * FROM customers WHERE active = 1 ORDER BY name");
  const products = await q("SELECT id, code, name, customer_part_no, drawing_no, uom, hsn, sale_rate, gst_rate FROM products WHERE active = 1 AND sellable = 1 ORDER BY code");
  const pos = await q("SELECT id, ref_no, doc_no, to_char(doc_date, 'YYYY-MM-DD') AS doc_date, party_id, party_name, status FROM documents WHERE doc_type = 'customer_po' AND status NOT IN ('Completed', 'Cancelled') ORDER BY id DESC LIMIT 300");
  return json({ customers, products, pos });
});

route("GET", "/api/invoices/from-doc/:id", async (c) => {
  require(c, "sales_invoice", "edit");
  const src = await one(`SELECT ${DOC_COLS} FROM documents WHERE id = $1 AND doc_type IN ('customer_po', 'delivery_challan')`, [Number(c.params.id)]);
  if (!src) fail(404, "Not found");
  const po = src.doc_type === "customer_po" ? src
    : src.parent_id ? await one(`SELECT ${DOC_COLS} FROM documents WHERE id = $1 AND doc_type = 'customer_po'`, [src.parent_id]) : null;
  const prog = (await progressOf(q, src.id))!;
  const ids = prog.lines.map((l: any) => l.product_id).filter(Boolean);
  const prods = ids.length ? await q("SELECT id, drawing_no, customer_part_no, code AS item_code, gst_rate FROM products WHERE id = ANY($1)", [ids]) : [];
  const pmap = Object.fromEntries(prods.map((p) => [p.id, p]));
  const lines = prog.lines.filter((l: any) => l.pending > 0).map((l: any) => ({ ...l, ...(pmap[l.product_id] || {}), qty: l.pending }));
  if (!lines.length) fail(400, "Everything on this document has already been invoiced.");
  return json({ po: po || { ...src, doc_no: "", doc_date: null, id: null }, lines, challan: src.doc_type === "delivery_challan" ? { id: src.id, ref_no: src.ref_no } : null, party_id: src.party_id });
});

route("GET", "/api/invoices/from-po/:id", async (c) => {
  require(c, "sales_invoice", "edit");
  const po = await one(`SELECT ${DOC_COLS} FROM documents WHERE id = $1 AND doc_type = 'customer_po'`, [Number(c.params.id)]);
  if (!po) fail(404, "PO not found");
  const lines = await q(`SELECT l.*, p.drawing_no, p.customer_part_no, p.code AS item_code, p.gst_rate FROM document_lines l
    LEFT JOIN products p ON p.id = l.product_id WHERE l.document_id = $1 ORDER BY l.line_no`, [po.id]);
  return json({ po, lines });
});

route("GET", "/api/invoices/:id", async (c) => {
  require(c, "sales_invoice");
  const inv = await one(`SELECT ${INV_COLS} FROM invoices WHERE id = $1`, [Number(c.params.id)]);
  if (!inv) fail(404, "Not found");
  const lines = await q("SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no", [inv.id]);
  return json({ inv, lines });
});

route("POST", "/api/invoices/save", async (c) => {
  require(c, "sales_invoice", "edit");
  const b = c.body;
  const id = num(b.id);
  const invDate = isoDate(b.inv_date) || fail(400, "Invoice date is required.");
  const customerId = num(b.customer_id) || fail(400, "Pick the customer.");
  const cust = await one("SELECT * FROM customers WHERE id = $1", [customerId]);
  if (!cust) fail(400, "Customer not found.");
  const lines: any[] = [];
  for (const l of (Array.isArray(b.lines) ? b.lines : []).slice(0, 200)) {
    const qty = num(l.qty), rate = num(l.rate), disc = num(l.disc) || 0;
    if (!str(l.description) && !qty) continue;
    if (!qty || rate === null) fail(400, `Line "${str(l.description) || "?"}": quantity and rate are needed.`);
    const amount = round2(qty! * rate! * (1 - disc / 100));
    lines.push([num(l.product_id), str(l.material_code), str(l.part_no), str(l.description), str(l.hsn), str(l.uom).toUpperCase(), qty, rate, disc, amount]);
  }
  if (!lines.length) fail(400, "Add at least one item.");
  const gstRate = num(b.gst_rate) ?? 18;
  const ownState = ((await one("SELECT value FROM settings WHERE key = 'company_gstin'"))?.value || "27").slice(0, 2);
  const custState = str(b.gstin || cust.gstin).slice(0, 2);
  const taxType = b.tax_type === "CGST_SGST" || b.tax_type === "IGST" ? b.tax_type : custState && custState !== ownState ? "IGST" : "CGST_SGST";
  const subtotal = round2(lines.reduce((s, l) => s + l[9], 0));
  const igst = taxType === "IGST" ? round2(subtotal * gstRate / 100) : 0;
  const cgst = taxType === "IGST" ? 0 : round2(subtotal * gstRate / 200);
  const sgst = cgst;
  const total = round2(subtotal + igst + cgst + sgst);
  const packing = (Array.isArray(b.packing) ? b.packing : []).slice(0, 200)
    .map((p: any) => ({ line: num(p.line), qty: num(p.qty) })).filter((p: any) => p.line && p.qty);
  const header: any = {
    inv_date: invDate, customer_id: customerId, customer_po_id: num(b.customer_po_id), po_no: str(b.po_no) || null,
    po_date: isoDate(b.po_date), supplier_code: str(b.supplier_code) || null, bill_to: str(b.bill_to), ship_to: str(b.ship_to),
    gstin: str(b.gstin).toUpperCase() || cust.gstin, pan: str(b.pan).toUpperCase() || cust.pan, tax_type: taxType, gst_rate: gstRate,
    subtotal, cgst, sgst, igst, total, delivery_condition: str(b.delivery_condition), payment_terms: str(b.payment_terms),
    packing: JSON.stringify(packing), status: ["Issued", "Cancelled"].includes(b.status) ? b.status : "Issued",
    challan_id: num(b.challan_id),
  };
  const res = await tx(async (query) => {
    let invId = id, invNo: string;
    if (id) {
      const ex = (await query("SELECT inv_no FROM invoices WHERE id = $1", [id]))[0] || fail(404, "Not found");
      invNo = ex.inv_no;
      const ks = Object.keys(header);
      await query(`UPDATE invoices SET ${ks.map((k, i) => `${k} = $${i + 1}`).join(", ")} WHERE id = $${ks.length + 1}`, [...Object.values(header), id]);
      await query("DELETE FROM invoice_lines WHERE invoice_id = $1", [id]);
    } else {
      invNo = await nextInvoiceNo(query, invDate);
      const all = { ...header, inv_no: invNo, created_by: c.user!.id };
      const ks = Object.keys(all);
      invId = (await query(`INSERT INTO invoices (${ks.join(", ")}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, Object.values(all)))[0].id;
    }
    for (let i = 0; i < lines.length; i++)
      await query(`INSERT INTO invoice_lines (invoice_id, line_no, product_id, material_code, part_no, description, hsn, uom, qty, rate, disc, amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [invId, i + 1, ...lines[i]]);
    if (header.customer_po_id && ["Open", "Partly Dispatched", "Completed"].includes(b.po_status))
      await query("UPDATE documents SET status = $1 WHERE id = $2 AND doc_type = 'customer_po'", [b.po_status, header.customer_po_id]);
    else if (header.customer_po_id) await refreshStatus(query, header.customer_po_id);
    if (header.challan_id) await refreshStatus(query, header.challan_id);
    return { id: invId, inv_no: invNo };
  });
  return json(res);
});

route("DELETE", "/api/invoices/:id", async (c) => {
  if (c.user?.role !== "Admin") fail(403, "Only Admin can delete an invoice. Others can mark it Cancelled.");
  const inv = await one("SELECT id, inv_no, customer_po_id, challan_id FROM invoices WHERE id = $1", [Number(c.params.id)]);
  if (!inv) fail(404, "Not found");
  let reuse = "";
  await tx(async (query) => {
    await query("DELETE FROM invoices WHERE id = $1", [inv.id]);
    // Deleting the latest invoice gives its number back, so the series stays without gaps.
    const m = String(inv.inv_no).match(/^(.*)\/(\d{2})-(\d+)$/);
    if (m) {
      const counter = `invoice_${m[2]}`;
      const cur = (await query("SELECT value FROM counters WHERE name = $1 FOR UPDATE", [counter]))[0]?.value;
      if (Number(cur) === Number(m[3])) {
        const rows = await query("SELECT inv_no FROM invoices WHERE inv_no LIKE $1", [`%/${m[2]}-%`]);
        const top = Math.max(0, ...rows.map((r: any) => Number(String(r.inv_no).match(/-(\d+)$/)?.[1] || 0)));
        await query("UPDATE counters SET value = $1 WHERE name = $2", [top, counter]);
        reuse = ` The next invoice will be ${m[1]}/${m[2]}-${String(top + 1).padStart(3, "0")}.`;
      }
    }
    if (inv.customer_po_id) await refreshStatus(query, inv.customer_po_id);
    if (inv.challan_id) await refreshStatus(query, inv.challan_id);
  });
  return json({ message: "Invoice deleted." + reuse });
});

route("GET", "/api/invoice-next", async (c) => {
  require(c, "sales_invoice");
  const day = isoDate(new URL(c.req.url).searchParams.get("date")) || new Date().toISOString().slice(0, 10);
  const fy = fyOf(day);
  const prefix = (await one("SELECT value FROM settings WHERE key = 'invoice_prefix'"))?.value || "R";
  const cur = Number((await one("SELECT value FROM counters WHERE name = $1", [`invoice_${fy}`]))?.value || 0);
  return json({ inv_no: `${prefix}/${fy}-${String(cur + 1).padStart(3, "0")}` });
});

route("GET", "/api/invoice-counter", async (c) => {
  if (!c.user) fail(401, "Please log in.");
  return json({ rows: await q("SELECT name, value FROM counters WHERE name LIKE 'invoice_%' ORDER BY name") });
});

route("PUT", "/api/invoice-counter", async (c) => {
  if (c.user?.role !== "Admin") fail(403, "Only Admin can change the invoice number series.");
  const fy = String(c.body.fy || "").padStart(2, "0");
  const last = num(c.body.last);
  if (!/^\d{2}$/.test(fy) || last === null || last < 0) fail(400, "Give the year (e.g. 26) and the last number used.");
  await q("INSERT INTO counters (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value", [`invoice_${fy}`, last]);
  return json({ ok: true });
});

// ---------------------------------------------------------------- linked documents
const lineKey = (l: any) => (l.product_id ? `p${l.product_id}` : `d${str(l.description).toLowerCase()}`);

/** Ordered vs done per line of a sales order / purchase order / challan / GRN. */
async function progressOf(query: any, docId: number) {
  const doc = (await query("SELECT id, doc_type FROM documents WHERE id = $1", [docId]))[0];
  if (!doc) return null;
  const lines = await query("SELECT * FROM document_lines WHERE document_id = $1 ORDER BY line_no", [docId]);
  let done: any[] = [];
  if (doc.doc_type === "customer_po") {
    done = await query(`SELECT l.product_id, l.description, l.qty FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE d.parent_id = $1 AND d.doc_type = 'delivery_challan' AND d.status <> 'Cancelled'
      UNION ALL SELECT l.product_id, l.description, l.qty FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
        WHERE i.customer_po_id = $1 AND i.challan_id IS NULL AND i.status <> 'Cancelled'`, [docId]);
  } else if (doc.doc_type === "purchase_order") {
    done = await query(`SELECT l.product_id, l.description, l.qty FROM document_lines l JOIN documents d ON d.id = l.document_id
      WHERE d.parent_id = $1 AND d.doc_type IN ('grn', 'vendor_invoice') AND d.status <> 'Cancelled'`, [docId]);
  } else if (doc.doc_type === "delivery_challan") {
    done = await query(`SELECT l.product_id, l.description, l.qty FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE i.challan_id = $1 AND i.status <> 'Cancelled'`, [docId]);
  } else if (doc.doc_type === "grn" || doc.doc_type === "quotation") {
    done = await query(`SELECT l.product_id, l.description, l.qty FROM document_lines l JOIN documents d ON d.id = l.document_id
      WHERE d.parent_id = $1 AND d.status <> 'Cancelled'`, [docId]);
  }
  const used: Record<string, number> = {};
  for (const r of done) used[lineKey(r)] = (used[lineKey(r)] || 0) + Number(r.qty || 0);
  const out = lines.map((l: any) => {
    const k = lineKey(l), take = Math.min(Number(l.qty || 0), Math.max(0, used[k] || 0));
    used[k] = (used[k] || 0) - take;
    return { ...l, done: take, pending: Math.round((Number(l.qty || 0) - take) * 1000) / 1000 };
  });
  return { doc, lines: out, anyDone: done.length > 0, allDone: out.every((l: any) => l.pending <= 0) };
}

/** Move a document's status forward after something was made from it. */
async function refreshStatus(query: any, docId: number) {
  const p = await progressOf(query, docId);
  if (!p) return;
  const cur = (await query("SELECT status FROM documents WHERE id = $1", [docId]))[0]?.status;
  if (cur === "Cancelled") return;
  const next: Record<string, string> = {
    quotation: p.anyDone ? "Accepted" : cur,
    customer_po: p.allDone ? "Completed" : p.anyDone ? "Partly Dispatched" : "Open",
    purchase_order: p.allDone ? "Received" : p.anyDone ? "Partly Received" : "Open",
    delivery_challan: p.allDone ? "Invoiced" : "Open",
    grn: p.anyDone ? "Billed" : "Received",
  };
  const st = next[p.doc.doc_type];
  if (st && st !== cur && !(p.doc.doc_type === "quotation" && cur === "Lost"))
    await query("UPDATE documents SET status = $1 WHERE id = $2", [st, docId]);
}

/** New document pre-filled from another one, with only the quantity still pending. */
route("GET", "/api/convert/:id/:target", async (c) => {
  const target = c.params.target;
  const td = docTypeOf(target);
  require(c, target, "edit");
  const src = await one(`SELECT ${DOC_COLS} FROM documents WHERE id = $1`, [Number(c.params.id)]);
  if (!src) fail(404, "Not found");
  if (!((CONVERT as any)[src.doc_type] || []).includes(target)) fail(400, "These documents cannot be converted.");
  const prog = (await progressOf(q, src.id))!;
  const fromOwn = (DOC_TYPES as any)[src.doc_type].own;
  const lines = prog.lines.filter((l: any) => l.pending > 0).map((l: any) => ({
    product_id: l.product_id, party_part_no: l.party_part_no, description: l.description, hsn: l.hsn, uom: l.uom,
    qty: l.pending, rate: l.rate, amount: l.rate !== null ? Math.round(l.pending * l.rate * 100) / 100 : null,
  }));
  if (!lines.length) fail(400, "Everything on this document has already been done.");
  const sub = lines.reduce((t: number, l: any) => t + (l.amount || 0), 0);
  const ratio = Number(src.subtotal) ? Number(src.total_amount || 0) / Number(src.subtotal) : 1.18;
  const doc: any = {
    party_id: src.party_id, party_name: src.party_name, party_gstin: src.party_gstin, doc_date: todayIso(), parent_id: src.id,
    status: td.statuses[0], total_amount: target === "vendor_invoice" ? null : Math.round(sub * (ratio || 1) * 100) / 100,
    doc_no: target === "customer_po" ? "" : target === "vendor_invoice" ? "" : null,
    notes: `From ${(DOC_TYPES as any)[src.doc_type].singular} ${src.ref_no}${!fromOwn && src.doc_no ? ` (${src.doc_no})` : ""}`,
    delivery_date: src.delivery_date,
  };
  return json({ doc, lines, source: { type: src.doc_type, id: src.id, ref_no: src.ref_no } });
});

/** The whole chain a document or invoice belongs to, plus pending quantities. */
route("GET", "/api/links/:kind/:id", async (c) => {
  if (!c.user) fail(401, "Please log in.");
  const id = Number(c.params.id);
  const docIds = new Set<number>();
  const invIds = new Set<number>();
  let start: number | null = null;
  if (c.params.kind === "invoice") {
    const inv = await one("SELECT id, customer_po_id, challan_id FROM invoices WHERE id = $1", [id]);
    if (!inv) fail(404, "Not found");
    invIds.add(inv.id);
    start = inv.challan_id || inv.customer_po_id;
  } else start = id;
  // walk up to the first document, then collect everything below it
  let root = start;
  for (let i = 0; root && i < 10; i++) {
    const r = await one("SELECT parent_id FROM documents WHERE id = $1", [root]);
    if (!r?.parent_id) break;
    root = r.parent_id;
  }
  if (root) {
    let frontier = [root];
    docIds.add(root);
    for (let i = 0; frontier.length && i < 10; i++) {
      const kids = await q("SELECT id FROM documents WHERE parent_id = ANY($1)", [frontier]);
      frontier = kids.map((k) => k.id).filter((k) => !docIds.has(k));
      frontier.forEach((k) => docIds.add(k));
    }
    for (const r of await q("SELECT id FROM invoices WHERE customer_po_id = ANY($1) OR challan_id = ANY($1)", [[...docIds]])) invIds.add(r.id);
  }
  const docs = docIds.size ? await q(`SELECT id, doc_type, ref_no, doc_no, to_char(doc_date, 'YYYY-MM-DD') AS day, status, total_amount AS amount, parent_id
    FROM documents WHERE id = ANY($1)`, [[...docIds]]) : [];
  const invs = invIds.size ? await q(`SELECT id, inv_no, to_char(inv_date, 'YYYY-MM-DD') AS day, status, total AS amount, customer_id FROM invoices WHERE id = ANY($1)`, [[...invIds]]) : [];
  const order = ["quotation", "customer_po", "purchase_order", "delivery_challan", "grn", "vendor_invoice"];
  const items = [
    ...docs.filter((d) => c.perms[d.doc_type] && c.perms[d.doc_type] !== "none").map((d) => ({
      type: d.doc_type, label: (DOC_TYPES as any)[d.doc_type].singular, ref: d.ref_no, no: d.doc_no !== d.ref_no ? d.doc_no : "",
      day: d.day, status: d.status, amount: d.amount, href: `#/d/${d.doc_type}/${d.id}`, current: c.params.kind === "doc" && d.id === id, rank: order.indexOf(d.doc_type),
    })),
    ...(c.perms.sales_invoice !== "none" ? invs : []).map((v) => ({
      type: "invoice", label: "Sales Invoice", ref: v.inv_no, no: "", day: v.day, status: v.status, amount: v.amount,
      href: `#/invoices/${v.id}`, current: c.params.kind === "invoice" && v.id === id, rank: 9,
    })),
  ].sort((a, b) => a.rank - b.rank || String(a.day).localeCompare(String(b.day)));
  let progress = null;
  if (c.params.kind === "doc") {
    const p = await progressOf(q, id);
    if (p && ["customer_po", "purchase_order", "delivery_challan", "grn"].includes(p.doc.doc_type))
      progress = p.lines.map((l: any) => ({ description: l.description, uom: l.uom, qty: l.qty, done: l.done, pending: l.pending }));
  }
  return json({ items, progress });
});

// ---------------------------------------------------------------- stock
// Balance = manual entries + vendor invoice receipts - sales invoice dispatches.
const STOCK_KINDS: Record<string, number> = { Opening: 1, Production: 1, Issue: -1, Adjustment: 0 };
const STOCK_SUM = `SELECT product_id, SUM(qty) FILTER (WHERE grp = 'manual') AS manual, SUM(qty) FILTER (WHERE grp = 'in') AS received,
  -SUM(qty) FILTER (WHERE grp = 'out') AS dispatched, SUM(qty) AS balance FROM stock_flow GROUP BY product_id`;

route("GET", "/api/stock", async (c) => {
  require(c, "stock");
  const sp = new URL(c.req.url).searchParams;
  const qs = str(sp.get("q")), cat = str(sp.get("cat"));
  const params: unknown[] = [];
  let where = "p.active = 1";
  if (qs) { params.push(`%${qs}%`); where += ` AND (p.code ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.customer_part_no ILIKE $${params.length} OR p.drawing_no ILIKE $${params.length})`; }
  if (cat && (PRODUCT_CATEGORIES as any)[cat]) { params.push(cat); where += ` AND p.category = $${params.length}`; }
  const rows = await q(`SELECT p.id, p.code, p.name, p.category, p.uom, p.customer_part_no,
      COALESCE(f.manual, 0) AS manual, COALESCE(f.received, 0) AS received, COALESCE(f.dispatched, 0) AS dispatched,
      COALESCE(f.balance, 0) AS balance
    FROM products p LEFT JOIN (${STOCK_SUM}) f ON f.product_id = p.id
    WHERE ${where} ORDER BY p.code`, params);
  return json({ rows });
});

route("GET", "/api/stock/moves", async (c) => {
  require(c, "stock");
  const rows = await q(`SELECT m.batch, to_char(MIN(m.move_date), 'YYYY-MM-DD') AS move_date, MIN(m.kind) FILTER (WHERE m.kind <> 'Consumed') AS kind,
      MIN(m.ref) AS ref, MIN(m.notes) AS notes, COUNT(*) AS lines,
      string_agg(p.code || ' ' || (CASE WHEN m.qty > 0 THEN '+' ELSE '' END) || m.qty, ', ' ORDER BY m.id) AS items, MIN(u.full_name) AS by_user
    FROM stock_moves m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.created_by
    GROUP BY m.batch ORDER BY MAX(m.id) DESC LIMIT 200`);
  return json({ rows });
});

route("GET", "/api/stock/item/:id", async (c) => {
  require(c, "stock");
  const id = Number(c.params.id);
  const product = await one("SELECT id, code, name, category, uom, customer_part_no, drawing_no FROM products WHERE id = $1", [id]);
  if (!product) fail(404, "Item not found");
  const rows = await q(`SELECT to_char(day, 'YYYY-MM-DD') AS day, kind, ref, party, qty, href FROM stock_flow
    WHERE product_id = $1 ORDER BY stock_flow.day, (CASE grp WHEN 'manual' THEN 0 WHEN 'in' THEN 1 ELSE 2 END), src_id`, [id]);
  let bal = 0;
  for (const r of rows) { bal += Number(r.qty); r.balance = Math.round(bal * 1000) / 1000; }
  return json({ product, rows, balance: bal });
});

route("POST", "/api/stock/move", async (c) => {
  require(c, "stock", "edit");
  const b = c.body;
  const kind = str(b.kind);
  if (!(kind in STOCK_KINDS)) fail(400, "Pick what kind of entry this is.");
  const day = isoDate(b.date) || fail(400, "Date is required.");
  const clean = (arr: any) => (Array.isArray(arr) ? arr : []).slice(0, 200)
    .map((l: any) => ({ product_id: num(l.product_id), qty: num(l.qty) })).filter((l: any) => l.product_id && l.qty);
  const lines = clean(b.lines);
  if (!lines.length) fail(400, "Add at least one item with a quantity.");
  const consume = kind === "Production" ? clean(b.consume) : [];
  const sign = STOCK_KINDS[kind];
  const batch = randomUUID().slice(0, 8);
  await tx(async (query) => {
    for (const l of lines)
      await query("INSERT INTO stock_moves (move_date, product_id, qty, kind, batch, ref, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [day, l.product_id, sign ? sign * Math.abs(l.qty) : l.qty, kind, batch, str(b.ref) || null, str(b.notes) || null, c.user!.id]);
    for (const l of consume)
      await query("INSERT INTO stock_moves (move_date, product_id, qty, kind, batch, ref, notes, created_by) VALUES ($1,$2,$3,'Consumed',$4,$5,$6,$7)",
        [day, l.product_id, -Math.abs(l.qty), batch, str(b.ref) || null, str(b.notes) || null, c.user!.id]);
  });
  return json({ ok: true, batch });
});

route("DELETE", "/api/stock/batch/:batch", async (c) => {
  require(c, "stock", "edit");
  await q("DELETE FROM stock_moves WHERE batch = $1", [c.params.batch]);
  return json({ ok: true });
});

// ---------------------------------------------------------------- material per piece (BOM)
const BOM_SQL = `SELECT b.product_id, b.component_id, b.qty_per, p.code, p.name, p.uom
  FROM product_bom b JOIN products p ON p.id = b.component_id`;

route("GET", "/api/bom", async (c) => {
  require(c, "stock");
  return json({ rows: await q(BOM_SQL + " ORDER BY b.product_id, b.id") });
});

route("GET", "/api/bom/:id", async (c) => {
  require(c, "products");
  const id = Number(c.params.id);
  return json({
    lines: await q(BOM_SQL + " WHERE b.product_id = $1 ORDER BY b.id", [id]),
    components: await q("SELECT id, code, name, uom FROM products WHERE active = 1 AND id <> $1 ORDER BY code", [id]),
  });
});

route("PUT", "/api/bom/:id", async (c) => {
  require(c, "products", "edit");
  const id = Number(c.params.id);
  if (!(await one("SELECT id FROM products WHERE id = $1", [id]))) fail(404, "Product not found");
  const seen = new Set<number>();
  const lines: [number, number][] = [];
  for (const l of (Array.isArray(c.body.lines) ? c.body.lines : []).slice(0, 100)) {
    const comp = num(l.component_id), qty = num(l.qty_per);
    if (!comp && !qty) continue;
    if (!comp || !qty || qty <= 0) fail(400, "Each line needs an item and a quantity per piece.");
    if (comp === id) fail(400, "A product cannot use itself.");
    if (seen.has(comp!)) fail(400, "The same item is listed twice.");
    seen.add(comp!); lines.push([comp!, qty!]);
  }
  await tx(async (query) => {
    await query("DELETE FROM product_bom WHERE product_id = $1", [id]);
    for (const [comp, qty] of lines)
      await query("INSERT INTO product_bom (product_id, component_id, qty_per) VALUES ($1, $2, $3)", [id, comp, qty]);
  });
  return json({ ok: true });
});

// ---------------------------------------------------------------- department dashboards
const DASH_VIEWS: Record<string, string> = { admin: "", sales: "sales_invoice", purchase: "vendor_invoice", store: "stock" };
const todayIso = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // India time
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);

/** Unpaid invoices per party after applying payments oldest-first; returns aging buckets and per-party rows. */
function aging(bills: any[], paid: Record<string, number>, today: string) {
  const buckets = { "0-30 days": 0, "31-60 days": 0, "61-90 days": 0, "Over 90 days": 0 };
  const parties: Record<string, any> = {};
  const left: Record<string, number> = { ...paid };
  for (const b of bills) {                                   // bills sorted by date
    const k = String(b.party_id);
    const use = Math.min(left[k] || 0, Number(b.amount));
    left[k] = (left[k] || 0) - use;
    const due = Math.round((Number(b.amount) - use) * 100) / 100;
    if (due <= 0.5) continue;
    const age = daysBetween(b.day, today);
    const bucket = age <= 30 ? "0-30 days" : age <= 60 ? "31-60 days" : age <= 90 ? "61-90 days" : "Over 90 days";
    (buckets as any)[bucket] += due;
    const p = (parties[k] ||= { id: b.party_id, name: b.name, due: 0, oldest: age, bills: 0 });
    p.due += due; p.bills++; p.oldest = Math.max(p.oldest, age);
  }
  return { buckets, parties: Object.values(parties).sort((a: any, b: any) => b.due - a.due) };
}

route("GET", "/api/dash/:view", async (c) => {
  if (!c.user) fail(401, "Please log in.");
  const view = c.params.view;
  if (!(view in DASH_VIEWS)) fail(404, "Unknown dashboard");
  if (view === "admin" ? c.user!.role !== "Admin" : c.perms[DASH_VIEWS[view]] === "none") fail(403, "Not allowed");
  const today = todayIso();
  const [y, m] = today.split("-").map(Number);
  const fyStart = `${m >= 4 ? y : y - 1}-04-01`;
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); months.push(d.toISOString().slice(0, 7)); }
  const from12 = months[0] + "-01";
  const thisMonth = today.slice(0, 7), lastMonth = months[10];
  const out: any = { today, fyStart, months };
  const wantSales = view === "admin" || view === "sales";
  const wantPurch = view === "admin" || view === "purchase";

  if (wantSales) {
    const rows = await q(`SELECT to_char(inv_date, 'YYYY-MM') AS m, SUM(subtotal) AS taxable, SUM(total) AS total, COUNT(*) AS n
      FROM invoices WHERE status <> 'Cancelled' AND inv_date >= $1 GROUP BY 1`, [from12]);
    const by = Object.fromEntries(rows.map((r) => [r.m, r]));
    out.salesByMonth = months.map((mm) => Number(by[mm]?.taxable || 0));
    out.salesThisMonth = Number(by[thisMonth]?.taxable || 0);
    out.salesLastMonth = Number(by[lastMonth]?.taxable || 0);
    out.invoicesThisMonth = Number(by[thisMonth]?.n || 0);
    out.salesFY = Number((await one("SELECT COALESCE(SUM(subtotal), 0) AS s FROM invoices WHERE status <> 'Cancelled' AND inv_date >= $1", [fyStart])).s);
    out.topCustomers = await q(`SELECT cu.name AS label, SUM(i.subtotal) AS value, COUNT(*) AS n FROM invoices i JOIN customers cu ON cu.id = i.customer_id
      WHERE i.status <> 'Cancelled' AND i.inv_date >= $1 GROUP BY cu.name ORDER BY value DESC LIMIT 6`, [fyStart]);
    out.topItems = await q(`SELECT COALESCE(p.name, l.description) AS label, SUM(l.amount) AS value, SUM(l.qty) AS qty FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id LEFT JOIN products p ON p.id = l.product_id
      WHERE i.status <> 'Cancelled' AND i.inv_date >= $1 GROUP BY 1 ORDER BY value DESC LIMIT 8`, [fyStart]);
    const names = Object.fromEntries((await q("SELECT id, name FROM customers")).map((r) => [r.id, r.name]));
    const bills = (await billStatus("in")).rows.map((b) => ({ party_id: b.party_id, name: names[b.party_id] || "", day: b.day, amount: b.balance }));
    const ag = aging(bills, {}, today);
    out.recvAging = ag.buckets; out.recvParties = ag.parties.slice(0, 10);
    out.toCollect = ag.parties.reduce((t: number, p: any) => t + p.due, 0);
    out.openPOs = Number((await one("SELECT COUNT(*) AS n FROM documents WHERE doc_type = 'customer_po' AND status IN ('Open', 'Partly Dispatched')")).n);
    out.receivedThisMonth = Number((await one("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE direction = 'in' AND to_char(pay_date, 'YYYY-MM') = $1", [thisMonth])).s);
  }
  if (wantPurch) {
    const rows = await q(`SELECT to_char(doc_date, 'YYYY-MM') AS m, SUM(COALESCE(subtotal, total_amount, 0)) AS taxable, SUM(COALESCE(total_amount, subtotal, 0)) AS total, COUNT(*) AS n
      FROM documents WHERE doc_type = 'vendor_invoice' AND status <> 'Cancelled' AND doc_date >= $1 GROUP BY 1`, [from12]);
    const by = Object.fromEntries(rows.map((r) => [r.m, r]));
    out.purchByMonth = months.map((mm) => Number(by[mm]?.taxable || 0));
    out.purchThisMonth = Number(by[thisMonth]?.taxable || 0);
    out.billsThisMonth = Number(by[thisMonth]?.n || 0);
    out.purchFY = Number((await one("SELECT COALESCE(SUM(COALESCE(subtotal, total_amount, 0)), 0) AS s FROM documents WHERE doc_type = 'vendor_invoice' AND status <> 'Cancelled' AND doc_date >= $1", [fyStart])).s);
    out.topVendors = await q(`SELECT v.name AS label, SUM(COALESCE(d.subtotal, d.total_amount, 0)) AS value FROM documents d JOIN vendors v ON v.id = d.party_id
      WHERE d.doc_type = 'vendor_invoice' AND d.status <> 'Cancelled' AND d.doc_date >= $1 GROUP BY v.name ORDER BY value DESC LIMIT 6`, [fyStart]);
    out.spendByCategory = await q(`SELECT COALESCE(p.category, 'Other') AS label, SUM(l.amount) AS value FROM document_lines l
      JOIN documents d ON d.id = l.document_id LEFT JOIN products p ON p.id = l.product_id
      WHERE d.doc_type = 'vendor_invoice' AND d.status <> 'Cancelled' AND d.doc_date >= $1 GROUP BY 1 ORDER BY value DESC`, [fyStart]);
    const names = Object.fromEntries((await q("SELECT id, name FROM vendors")).map((r) => [r.id, r.name]));
    const bills = (await billStatus("out")).rows.map((b) => ({ party_id: b.party_id, name: names[b.party_id] || "", day: b.day, amount: b.balance }));
    const ag = aging(bills, {}, today);
    out.payAging = ag.buckets; out.payParties = ag.parties.slice(0, 10);
    out.toPay = ag.parties.reduce((t: number, p: any) => t + p.due, 0);
    out.recentBills = await q(`SELECT id, ref_no, doc_no, to_char(doc_date, 'YYYY-MM-DD') AS doc_date, party_name, total_amount, status FROM documents
      WHERE doc_type = 'vendor_invoice' ORDER BY doc_date DESC NULLS LAST, id DESC LIMIT 8`);
  }
  if (view === "store" || view === "admin") {
    const stock = await q(`SELECT p.id, p.code, p.name, p.category, p.uom, COALESCE(f.balance, 0) AS balance
      FROM products p LEFT JOIN (${STOCK_SUM}) f ON f.product_id = p.id WHERE p.active = 1 ORDER BY p.code`);
    out.stock = stock.map((r) => ({ ...r, balance: Number(r.balance) }));
    const disp = await q(`SELECT to_char(day, 'YYYY-MM') AS m, -SUM(qty) AS q FROM stock_flow WHERE grp = 'out' AND day >= $1 GROUP BY 1`, [from12]);
    const dby = Object.fromEntries(disp.map((r) => [r.m, Number(r.q)]));
    out.dispatchByMonth = months.map((mm) => dby[mm] || 0);
    const made = await q(`SELECT to_char(move_date, 'YYYY-MM') AS m, SUM(qty) AS q FROM stock_moves WHERE kind = 'Production' AND move_date >= $1 GROUP BY 1`, [from12]);
    const mby = Object.fromEntries(made.map((r) => [r.m, Number(r.q)]));
    out.productionByMonth = months.map((mm) => mby[mm] || 0);
    out.receiptsThisMonth = Number((await one(`SELECT COUNT(DISTINCT d.id) AS n FROM documents d WHERE d.doc_type = 'vendor_invoice' AND d.status <> 'Cancelled'
      AND to_char(d.doc_date, 'YYYY-MM') = $1`, [thisMonth])).n);
    out.recentMoves = await q(`SELECT to_char(MIN(m.move_date), 'YYYY-MM-DD') AS move_date, MIN(m.kind) FILTER (WHERE m.kind <> 'Consumed') AS kind,
        string_agg(p.code || ' ' || (CASE WHEN m.qty > 0 THEN '+' ELSE '' END) || m.qty, ', ' ORDER BY m.id) AS items
      FROM stock_moves m JOIN products p ON p.id = m.product_id GROUP BY m.batch ORDER BY MAX(m.id) DESC LIMIT 6`);
  }
  if (view === "admin") {
    out.users = Number((await one("SELECT COUNT(*) AS n FROM users WHERE active = 1")).n);
    out.counts = {
      customers: Number((await one("SELECT COUNT(*) AS n FROM customers WHERE active = 1")).n),
      vendors: Number((await one("SELECT COUNT(*) AS n FROM vendors WHERE active = 1")).n),
      products: Number((await one("SELECT COUNT(*) AS n FROM products WHERE active = 1")).n),
    };
  }
  return json(out);
});

// ---------------------------------------------------------------- load existing data (e.g. Vyapar reports)
// The browser reads the Excel reports and sends clean records. Everything is matched
// to what already exists, so loading the same file twice adds nothing new.
route("POST", "/api/admin/load", async (c) => {
  if (c.user?.role !== "Admin") fail(403, "Only Admin can load data.");
  const b = c.body;
  const arr = (v: any, max: number) => (Array.isArray(v) ? v.slice(0, max) : []);
  const done = { customers: 0, vendors: 0, products: 0, sales: 0, purchases: 0, payments: 0, skipped: 0 };
  const ownState = ((await one("SELECT value FROM settings WHERE key = 'company_gstin'"))?.value || "27").slice(0, 2);
  await tx(async (query) => {
    // parties: match by GSTIN, else by name
    const partyIds: Record<string, Record<string, number>> = { customers: {}, vendors: {} };
    for (const master of ["customers", "vendors"] as const) {
      for (const p of arr(b[master], 2000)) {
        const { values } = cleanMaster(master, { ...p, active: true });
        if (!values.name) continue;
        let row = values.gstin ? (await query(`SELECT id FROM ${master} WHERE gstin = $1 LIMIT 1`, [values.gstin]))[0] : null;
        row ||= (await query(`SELECT id FROM ${master} WHERE lower(name) = lower($1) LIMIT 1`, [values.name]))[0];
        if (row) {
          const fill = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== null && v !== "" && k !== "name" && k !== "active"));
          const cur = (await query(`SELECT * FROM ${master} WHERE id = $1`, [row.id]))[0];
          await updateMaster(query, master, row.id, Object.fromEntries(Object.entries(fill).filter(([k]) => cur[k] === null || cur[k] === "")));
        } else { row = await insertMaster(query, master, values); done[master]++; }
        partyIds[master][str(p.key)] = row.id;
      }
    }
    // products: match by customer material code, then drawing no, then name
    const productIds: Record<string, number> = {};
    for (const p of arr(b.products, 5000)) {
      const { values } = cleanMaster("products", { ...p, active: true });
      if (!values.name) continue;
      let row = values.customer_part_no ? (await query("SELECT id FROM products WHERE customer_part_no = $1 LIMIT 1", [values.customer_part_no]))[0] : null;
      if (!row && values.drawing_no) row = (await query("SELECT id FROM products WHERE drawing_no = $1 AND category = $2 LIMIT 1", [values.drawing_no, values.category]))[0];
      row ||= (await query("SELECT id FROM products WHERE lower(name) = lower($1) LIMIT 1", [values.name]))[0];
      if (!row) { row = await insertMaster(query, "products", values); done.products++; }
      productIds[str(p.key)] = row.id;
    }
    const payment = async (dir: string, partyId: number, day: string, amount: number, ref: string, mode: string, notes: string) => {
      if (!amount || amount <= 0) return;
      const ex = (await query("SELECT id FROM payments WHERE direction = $1 AND party_id = $2 AND reference = $3", [dir, partyId, ref]))[0];
      if (ex) return;
      await query("INSERT INTO payments (direction, party_id, pay_date, amount, mode, reference, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [dir, partyId, day, round2(amount), mode, ref, notes, c.user!.id]);
      done.payments++;
    };
    // sales invoices
    const maxNo: Record<string, number> = {};
    for (const s of arr(b.sales, 5000)) {
      const custId = partyIds.customers[str(s.party_key)];
      const day = isoDate(s.date);
      if (!custId || !day || !str(s.inv_no)) { done.skipped++; continue; }
      const m = str(s.inv_no).match(/^[A-Z]*\/(\d{2})-(\d+)$/);
      if (m) maxNo[m[1]] = Math.max(maxNo[m[1]] || 0, Number(m[2]));
      let inv = (await query("SELECT id FROM invoices WHERE inv_no = $1", [s.inv_no]))[0];
      if (!inv) {
        const cust = (await query("SELECT * FROM customers WHERE id = $1", [custId]))[0];
        const lines = arr(s.lines, 200).map((l: any) => ({ ...l, qty: num(l.qty) || 0, rate: num(l.rate) || 0 }));
        const subtotal = round2(lines.reduce((t: number, l: any) => t + l.qty * l.rate, 0));
        const tax = round2(num(s.tax) ?? 0);
        const igstType = str(cust.gstin).slice(0, 2) && str(cust.gstin).slice(0, 2) !== ownState;
        const total = num(s.total) ?? round2(subtotal + tax);
        inv = (await query(`INSERT INTO invoices (inv_no, inv_date, customer_id, po_no, supplier_code, bill_to, ship_to, gstin, pan, tax_type, gst_rate,
            subtotal, cgst, sgst, igst, total, delivery_condition, payment_terms, packing, status, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'[]','Issued',$19) RETURNING id`,
          [s.inv_no, day, custId, str(s.po_no) || null, cust.supplier_code, [cust.name, cust.address, [cust.city, cust.state].filter(Boolean).join(", ")].filter(Boolean).join("\n"),
            "", cust.gstin, cust.pan, igstType ? "IGST" : "CGST_SGST", num(s.gst_rate) ?? 18, subtotal,
            igstType ? 0 : round2(tax / 2), igstType ? 0 : round2(tax - round2(tax / 2)), igstType ? tax : 0, total, cust.delivery_condition || "", cust.payment_terms || "", c.user!.id]))[0];
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          await query(`INSERT INTO invoice_lines (invoice_id, line_no, product_id, material_code, part_no, description, hsn, uom, qty, rate, disc, amount)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11)`,
            [inv.id, i + 1, productIds[str(l.product_key)] || null, str(l.material_code), str(l.part_no), str(l.description), str(l.hsn), str(l.uom).toUpperCase(), l.qty, l.rate, round2(l.qty * l.rate)]);
        }
        done.sales++;
      } else done.skipped++;
      await payment("in", custId, day, num(s.received) || 0, `Old record ${s.inv_no}`, str(s.pay_mode) || "As per old records", "Received before the ERP (payment date not in the old records)");
    }
    for (const [fy, n] of Object.entries(maxNo))
      await query("INSERT INTO counters (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value)", [`invoice_${fy}`, n]);
    // vendor invoices
    for (const p of arr(b.purchases, 5000)) {
      const venId = partyIds.vendors[str(p.party_key)];
      const day = isoDate(p.date);
      if (!venId || !day || !str(p.doc_no)) { done.skipped++; continue; }
      const ven = (await query("SELECT name, gstin FROM vendors WHERE id = $1", [venId]))[0];
      let doc = (await query("SELECT id FROM documents WHERE doc_type = 'vendor_invoice' AND party_id = $1 AND lower(doc_no) = lower($2)", [venId, p.doc_no]))[0];
      if (!doc) {
        const lines = arr(p.lines, 300).map((l: any) => ({ ...l, qty: num(l.qty) || 0, rate: num(l.rate) || 0 }));
        const subtotal = round2(lines.reduce((t: number, l: any) => t + l.qty * l.rate, 0));
        const total = num(p.total) ?? subtotal;
        const refNo = await nextCode(query, "doc_vendor_invoice", "VIN");
        doc = (await query(`INSERT INTO documents (doc_type, ref_no, doc_no, doc_date, party_id, party_name, party_gstin, subtotal, tax_amount, total_amount, notes, status, created_by)
          VALUES ('vendor_invoice',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [refNo, p.doc_no, day, venId, ven.name, ven.gstin, subtotal, round2(total - subtotal), total, "Loaded from old records",
            (num(p.balance) || 0) <= 0.01 && (num(p.paid) || 0) > 0 ? "Paid" : "Received", c.user!.id]))[0];
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          await query(`INSERT INTO document_lines (document_id, line_no, product_id, party_part_no, description, hsn, qty, uom, rate, amount)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [doc.id, i + 1, productIds[str(l.product_key)] || null, str(l.part_no), str(l.description), str(l.hsn), l.qty, str(l.uom).toUpperCase(), l.rate, round2(l.qty * l.rate)]);
        }
        done.purchases++;
      } else done.skipped++;
      await payment("out", venId, day, num(p.paid) || 0, `Old record ${p.doc_no}`, str(p.pay_mode) || "As per old records", "Paid before the ERP (payment date not in the old records)");
    }
  });
  return json({ done });
});

// ---------------------------------------------------------------- sales register
route("GET", "/api/reports/sales", async (c) => {
  require(c, "sales_invoice");
  const sp = new URL(c.req.url).searchParams;
  const from = isoDate(sp.get("from")) || "1900-01-01", to = isoDate(sp.get("to")) || "2999-12-31";
  const rows = await q(`SELECT i.id, i.inv_no, to_char(i.inv_date, 'YYYY-MM-DD') AS inv_date, to_char(i.inv_date, 'YYYY-MM') AS month,
      cu.name AS customer, i.gstin, i.po_no, i.subtotal, i.cgst, i.sgst, i.igst, i.total
    FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id
    WHERE i.status <> 'Cancelled' AND i.inv_date BETWEEN $1 AND $2 ORDER BY i.inv_date, i.id`, [from, to]);
  return json({ rows });
});

// ---------------------------------------------------------------- e-way bill
// The browser builds the e-way bill upload file; we hand it the data and keep the transport details.
const EWAY_KINDS: Record<string, string> = { invoice: "sales_invoice", delivery_challan: "delivery_challan" };
const EWAY_KEYS = ["reason", "mode", "vehicle_no", "transporter_id", "transporter_name", "distance", "trans_doc_no", "trans_doc_date", "ewb_no", "ewb_date"];

async function ewayRecord(kind: string, id: number) {
  if (kind === "invoice") {
    const inv = await one(`SELECT ${INV_COLS} FROM invoices WHERE id = $1`, [id]);
    if (!inv) fail(404, "Not found");
    const lines = await q(`SELECT l.*, p.name AS product_name, p.gst_rate AS product_gst FROM invoice_lines l
      LEFT JOIN products p ON p.id = l.product_id WHERE l.invoice_id = $1 ORDER BY l.line_no`, [id]);
    const party = inv.customer_id ? await one("SELECT * FROM customers WHERE id = $1", [inv.customer_id]) : null;
    return { doc: inv, lines, party };
  }
  const doc = await one(`SELECT ${DOC_COLS} FROM documents WHERE id = $1 AND doc_type = $2`, [id, kind]);
  if (!doc) fail(404, "Not found");
  const lines = await q(`SELECT l.*, p.name AS product_name, p.gst_rate AS product_gst FROM document_lines l
    LEFT JOIN products p ON p.id = l.product_id WHERE l.document_id = $1 ORDER BY l.line_no`, [id]);
  const party = doc.party_id ? await one("SELECT * FROM customers WHERE id = $1", [doc.party_id]) : null;
  return { doc, lines, party };
}

route("GET", "/api/eway/:kind/:id", async (c) => {
  const mod = EWAY_KINDS[c.params.kind] || fail(404, "E-way bills are made from invoices and delivery challans.");
  require(c, mod);
  return json(await ewayRecord(c.params.kind, Number(c.params.id)));
});

route("PUT", "/api/eway/:kind/:id", async (c) => {
  const mod = EWAY_KINDS[c.params.kind] || fail(404, "E-way bills are made from invoices and delivery challans.");
  require(c, mod, "edit");
  const id = Number(c.params.id);
  const rec = await ewayRecord(c.params.kind, id);
  const e: Record<string, any> = { ...(rec.doc.eway || {}) };
  for (const k of EWAY_KEYS) if (k in (c.body || {})) e[k] = str(c.body[k]);
  if (e.vehicle_no) e.vehicle_no = e.vehicle_no.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (e.ewb_no) {
    e.ewb_no = e.ewb_no.replace(/\D/g, "");
    if (e.ewb_no.length !== 12) fail(400, "The e-way bill number has 12 digits.");
  }
  const table = c.params.kind === "invoice" ? "invoices" : "documents";
  await q(`UPDATE ${table} SET eway = $1 WHERE id = $2`, [JSON.stringify(e), id]);
  const km = num(e.distance);
  if (rec.party && km && !rec.party.distance_km) await q("UPDATE customers SET distance_km = $1 WHERE id = $2", [Math.round(km), rec.party.id]);
  return json({ ok: true, eway: e });
});

// ---------------------------------------------------------------- accounts
// Receivable = issued sales invoices - payments in. Payable = vendor invoices - payments out.
const RECV_SQL = `SELECT cu.id, cu.code, cu.name, COALESCE(b.amt, 0) AS billed, COALESCE(p.amt, 0) AS settled,
    COALESCE(b.amt, 0) - COALESCE(p.amt, 0) AS balance, b.last_bill
  FROM customers cu
  LEFT JOIN (SELECT customer_id, SUM(total) AS amt, to_char(MAX(inv_date), 'YYYY-MM-DD') AS last_bill FROM invoices WHERE status <> 'Cancelled' GROUP BY customer_id) b ON b.customer_id = cu.id
  LEFT JOIN (SELECT party_id, SUM(amount) AS amt FROM payments WHERE direction = 'in' GROUP BY party_id) p ON p.party_id = cu.id
  WHERE b.amt IS NOT NULL OR p.amt IS NOT NULL ORDER BY balance DESC, cu.name`;
const PAY_SQL = `SELECT v.id, v.code, v.name, COALESCE(b.amt, 0) AS billed, COALESCE(p.amt, 0) AS settled,
    COALESCE(b.amt, 0) - COALESCE(p.amt, 0) AS balance, b.last_bill
  FROM vendors v
  LEFT JOIN (SELECT party_id, SUM(COALESCE(total_amount, subtotal, 0)) AS amt, to_char(MAX(doc_date), 'YYYY-MM-DD') AS last_bill FROM documents
    WHERE doc_type = 'vendor_invoice' AND status <> 'Cancelled' GROUP BY party_id) b ON b.party_id = v.id
  LEFT JOIN (SELECT party_id, SUM(amount) AS amt FROM payments WHERE direction = 'out' GROUP BY party_id) p ON p.party_id = v.id
  WHERE b.amt IS NOT NULL OR p.amt IS NOT NULL ORDER BY balance DESC, v.name`;

route("GET", "/api/accounts/summary", async (c) => {
  require(c, "accounts");
  return json({ receivable: await q(RECV_SQL), payable: await q(PAY_SQL) });
});

route("GET", "/api/accounts/statement/:dir/:id", async (c) => {
  require(c, "accounts");
  const dir = c.params.dir === "out" ? "out" : "in";
  const id = Number(c.params.id);
  const party = await one(`SELECT id, code, name, gstin, payment_terms FROM ${dir === "in" ? "customers" : "vendors"} WHERE id = $1`, [id]);
  if (!party) fail(404, "Not found");
  const bills = dir === "in"
    ? `SELECT to_char(inv_date, 'YYYY-MM-DD') AS day, 'Invoice' AS kind, inv_no AS ref, po_no AS notes, total AS debit, 0 AS credit, id AS sort2, '#/invoices/' || id AS href, NULL::int AS pay_id
        FROM invoices WHERE customer_id = $1 AND status <> 'Cancelled'`
    : `SELECT to_char(COALESCE(doc_date, created_at::date), 'YYYY-MM-DD'), 'Invoice', COALESCE(doc_no, ref_no), ref_no, COALESCE(total_amount, subtotal, 0), 0, id, '#/d/vendor_invoice/' || id, NULL::int
        FROM documents WHERE party_id = $1 AND doc_type = 'vendor_invoice' AND status <> 'Cancelled'`;
  const rows = await q(`SELECT * FROM (${bills}
      UNION ALL SELECT to_char(pay_date, 'YYYY-MM-DD'), 'Payment', COALESCE(mode, '') || COALESCE(' ' || reference, ''), notes, 0, amount, 1000000000 + id, NULL, id
        FROM payments WHERE direction = $2 AND party_id = $1) x ORDER BY day, sort2`, [id, dir]);
  let bal = 0;
  for (const r of rows) { bal += Number(r.debit) - Number(r.credit); r.balance = Math.round(bal * 100) / 100; }
  const st = await billStatus(dir, id);
  return json({ party, rows, balance: Math.round(bal * 100) / 100, bills: st.rows, advance: st.advance[id] || 0 });
});

// Bill-wise status: money tied to a bill counts first; the rest of a party's payments goes to its oldest open bills.
async function billStatus(dir: "in" | "out", partyId: number | null = null) {
  const bills = await q(dir === "in"
    ? `SELECT id, inv_no AS ref, to_char(inv_date, 'YYYY-MM-DD') AS day, customer_id AS party_id, COALESCE(total, 0) AS total, po_no AS note
        FROM invoices WHERE status <> 'Cancelled' AND ($1::int IS NULL OR customer_id = $1) ORDER BY inv_date, id`
    : `SELECT id, COALESCE(doc_no, ref_no) AS ref, to_char(COALESCE(doc_date, created_at::date), 'YYYY-MM-DD') AS day, party_id,
        COALESCE(total_amount, subtotal, 0) AS total, ref_no AS note
        FROM documents WHERE doc_type = 'vendor_invoice' AND status <> 'Cancelled' AND ($1::int IS NULL OR party_id = $1) ORDER BY doc_date, id`, [partyId]);
  const allocs = await q(`SELECT a.bill_id, SUM(a.amount) AS amt FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
    WHERE p.direction = $1 AND ($2::int IS NULL OR p.party_id = $2) GROUP BY a.bill_id`, [dir, partyId]);
  const loose = await q(`SELECT p.party_id, SUM(p.amount - COALESCE(a.amt, 0)) AS amt FROM payments p
    LEFT JOIN (SELECT payment_id, SUM(amount) AS amt FROM payment_allocations GROUP BY payment_id) a ON a.payment_id = p.id
    WHERE p.direction = $1 AND ($2::int IS NULL OR p.party_id = $2) GROUP BY p.party_id`, [dir, partyId]);
  const linked = Object.fromEntries(allocs.map((r) => [r.bill_id, Number(r.amt)]));
  const free: Record<string, number> = Object.fromEntries(loose.map((r) => [r.party_id, Math.max(0, Number(r.amt))]));
  const rows = bills.map((b) => {
    const total = round2(Number(b.total));
    const direct = round2(Math.min(total, linked[b.id] || 0));
    const auto = round2(Math.min(total - direct, free[b.party_id] || 0));
    free[b.party_id] = round2((free[b.party_id] || 0) - auto);
    const paid = round2(direct + auto), balance = round2(total - paid);
    return { ...b, total, direct, auto, paid, balance, pay_status: balance <= 0.5 ? "Paid" : paid > 0 ? "Part paid" : "Unpaid" };
  });
  return { rows, advance: free };
}

route("GET", "/api/bills/:dir", async (c) => {
  const dir = c.params.dir === "out" ? "out" : "in";
  if (c.perms.accounts === "none" && c.perms[dir === "in" ? "sales_invoice" : "vendor_invoice"] === "none") fail(403, "Not allowed");
  const party = num(new URL(c.req.url).searchParams.get("party"));
  const { rows, advance } = await billStatus(dir, party);
  return json({ rows, advance: party ? advance[party] || 0 : null });
});

route("GET", "/api/bills/:dir/:id", async (c) => {
  const dir = c.params.dir === "out" ? "out" : "in";
  if (!c.user) fail(401, "Please log in.");
  const id = Number(c.params.id);
  const owner = dir === "in" ? await one("SELECT customer_id AS p FROM invoices WHERE id = $1", [id])
    : await one("SELECT party_id AS p FROM documents WHERE id = $1 AND doc_type = 'vendor_invoice'", [id]);
  if (!owner) fail(404, "Not found");
  const { rows } = await billStatus(dir, owner.p);
  const bill = rows.find((r) => r.id === id) || null;
  const payments = await q(`SELECT p.id, to_char(p.pay_date, 'YYYY-MM-DD') AS pay_date, p.mode, p.reference, a.amount FROM payment_allocations a
    JOIN payments p ON p.id = a.payment_id WHERE a.bill_id = $1 AND p.direction = $2 ORDER BY p.pay_date`, [id, dir]);
  return json({ bill, payments });
});

route("GET", "/api/payments/options", async (c) => {
  require(c, "accounts", "edit");
  return json({
    customers: await q("SELECT id, code, name FROM customers WHERE active = 1 ORDER BY name"),
    vendors: await q("SELECT id, code, name FROM vendors WHERE active = 1 ORDER BY name"),
  });
});

route("GET", "/api/payments", async (c) => {
  require(c, "accounts");
  const rows = await q(`SELECT p.id, p.direction, to_char(p.pay_date, 'YYYY-MM-DD') AS pay_date, p.amount, p.mode, p.reference, p.notes, p.party_id,
      CASE WHEN p.direction = 'in' THEN cu.name ELSE v.name END AS party,
      (SELECT string_agg(CASE WHEN p.direction = 'in' THEN i.inv_no ELSE COALESCE(d.doc_no, d.ref_no) END, ', ')
        FROM payment_allocations a LEFT JOIN invoices i ON p.direction = 'in' AND i.id = a.bill_id
        LEFT JOIN documents d ON p.direction = 'out' AND d.id = a.bill_id WHERE a.payment_id = p.id) AS against
    FROM payments p LEFT JOIN customers cu ON p.direction = 'in' AND cu.id = p.party_id LEFT JOIN vendors v ON p.direction = 'out' AND v.id = p.party_id
    ORDER BY p.pay_date DESC, p.id DESC LIMIT 300`);
  return json({ rows });
});

route("POST", "/api/payments", async (c) => {
  require(c, "accounts", "edit");
  const b = c.body;
  const dir = b.direction === "out" ? "out" : "in";
  const partyId = num(b.party_id) || fail(400, dir === "in" ? "Pick the customer." : "Pick the vendor.");
  const day = isoDate(b.pay_date) || fail(400, "Date is required.");
  const amount = num(b.amount);
  if (!amount || amount <= 0) fail(400, "Enter the amount.");
  const exists = await one(`SELECT id FROM ${dir === "in" ? "customers" : "vendors"} WHERE id = $1`, [partyId]);
  if (!exists) fail(400, "Party not found.");
  const allocs = (Array.isArray(b.allocations) ? b.allocations : [])
    .map((a: any) => ({ bill_id: num(a.bill_id), amount: round2(num(a.amount) || 0) })).filter((a: any) => a.bill_id && a.amount > 0);
  const tied = round2(allocs.reduce((t: number, a: any) => t + a.amount, 0));
  if (tied > amount + 0.01) fail(400, `The bills ticked add up to ₹ ${tied}, more than the payment of ₹ ${amount}.`);
  if (allocs.length) {
    const { rows } = await billStatus(dir, partyId);
    for (const a of allocs) {
      const bill = rows.find((r) => r.id === a.bill_id) || fail(400, "One of the bills does not belong to this party.");
      const open = round2(bill.total - bill.direct);
      if (a.amount > open + 0.01) fail(400, `Bill ${bill.ref} has only ₹ ${open} left to settle.`);
    }
  }
  const id = await tx(async (query) => {
    const row = (await query("INSERT INTO payments (direction, party_id, pay_date, amount, mode, reference, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [dir, partyId, day, amount, str(b.mode) || null, str(b.reference) || null, str(b.notes) || null, c.user!.id]))[0];
    for (const a of allocs) await query("INSERT INTO payment_allocations (payment_id, bill_id, amount) VALUES ($1, $2, $3)", [row.id, a.bill_id, a.amount]);
    return row.id;
  });
  return json({ id });
});

route("DELETE", "/api/payments/:id", async (c) => {
  require(c, "accounts", "edit");
  await q("UPDATE bank_lines SET status = 'new', payment_id = NULL, posted_as = NULL WHERE payment_id = $1", [Number(c.params.id)]);
  await q("DELETE FROM payments WHERE id = $1", [Number(c.params.id)]);
  return json({ ok: true });
});

// ---------------------------------------------------------------- bank statement
const EXPENSE_CATEGORIES = ["Bank charges", "Salary & wages", "Rent", "Electricity", "GST paid", "TDS / income tax paid",
  "Freight & transport", "Fuel & travel", "Repairs & maintenance", "Office & admin", "Loan / EMI", "Interest paid",
  "Cash withdrawal", "Transfer to own account", "Owner / capital", "Other expense", "Interest received", "Other income"];
const STOP = new Set(["PVT", "LTD", "PRIVATE", "LIMITED", "LLP", "INDIA", "AND", "THE", "COMPANY", "CO", "ENTERPRISES", "INDUSTRIES", "M/S", "MS", "TECH",
  "NEFT", "RTGS", "IMPS", "UPI", "INB", "TRF", "TRANSFER", "FROM", "BY", "TO", "CR", "DR", "CHQ", "CHEQUE", "CLG", "DEP", "PAYMENT", "SBIN", "HDFC", "ICIC", "UTIB"]);
const words = (t: string) => String(t || "").toUpperCase().replace(/[^A-Z ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
const ruleKey = (desc: string) => words(desc).slice(0, 3).join(" ");
const payMode = (desc: string) => (/RTGS/i.test(desc) ? "RTGS" : /NEFT/i.test(desc) ? "NEFT" : /IMPS/i.test(desc) ? "IMPS" : /UPI/i.test(desc) ? "UPI"
  : /CHQ|CHEQUE|CLG|CLEARING/i.test(desc) ? "Cheque" : /CASH|ATM/i.test(desc) ? "Cash" : "Other");
function guessCategory(desc: string, credit: boolean) {
  const d = desc.toUpperCase();
  if (credit) return /INT\.?\s*(PD|PAID|CR)|INTEREST/.test(d) ? "Interest received" : "";
  if (/CHRG|CHARGE|SMS|COMMISSION|FEE|GST ON|AMC|DEBIT CARD|MAINT/.test(d)) return "Bank charges";
  if (/SALARY|SAL |WAGES|PAYROLL/.test(d)) return "Salary & wages";
  if (/GST|CBIC|GSTN/.test(d)) return "GST paid";
  if (/CBDT|TDS|ITNS|INCOME TAX|ADVANCE TAX/.test(d)) return "TDS / income tax paid";
  if (/ATM|CASH W|SELF/.test(d)) return "Cash withdrawal";
  if (/EMI|LOAN/.test(d)) return "Loan / EMI";
  if (/RENT/.test(d)) return "Rent";
  if (/MSEB|MSEDCL|ELECTRIC|POWER|TATA POWER/.test(d)) return "Electricity";
  if (/PETROL|FUEL|HPCL|IOCL|BPCL|FASTAG|TOLL/.test(d)) return "Fuel & travel";
  if (/TRANSPORT|LOGISTIC|COURIER|ROADWAYS|FREIGHT/.test(d)) return "Freight & transport";
  return "";
}

/** Best bills for an amount: exact single bill, then oldest run, then any group, else oldest first. */
function matchAmount(open: any[], amt: number) {
  const near = (x: number) => Math.abs(x - amt) <= 1;
  const one = open.find((b) => near(b.balance));
  if (one) return { exact: true, pick: [{ id: one.id, ref: one.ref, amount: one.balance }] };
  let run = 0;
  for (let i = 0; i < open.length; i++) {
    run = round2(run + open[i].balance);
    if (near(run)) return { exact: true, pick: open.slice(0, i + 1).map((b) => ({ id: b.id, ref: b.ref, amount: b.balance })) };
    if (run > amt + 1) break;
  }
  let best: any[] | null = null, steps = 0;
  const dfs = (i: number, sum: number, chosen: any[]) => {
    if (best || ++steps > 100000) return;
    if (chosen.length && near(sum)) { best = chosen.slice(); return; }
    if (sum > amt + 1 || i >= open.length) return;
    chosen.push(open[i]); dfs(i + 1, sum + open[i].balance, chosen); chosen.pop();
    dfs(i + 1, sum, chosen);
  };
  if (open.length <= 30) dfs(0, 0, []);
  if (best) return { exact: true, pick: (best as any[]).map((b) => ({ id: b.id, ref: b.ref, amount: b.balance })) };
  let left = amt; const pick = [];
  for (const b of open) { if (left <= 0.005) break; const use = round2(Math.min(left, b.balance)); pick.push({ id: b.id, ref: b.ref, amount: use }); left = round2(left - use); }
  return { exact: false, pick };
}

async function bankSuggestions(lines: any[]) {
  const customers = await q("SELECT id, name FROM customers WHERE active = 1");
  const vendors = await q("SELECT id, name FROM vendors WHERE active = 1");
  const rules = Object.fromEntries((await q("SELECT * FROM bank_rules")).map((r) => [r.key, r]));
  const billsIn = (await billStatus("in")).rows.filter((b) => b.balance > 0.5);
  const billsOut = (await billStatus("out")).rows.filter((b) => b.balance > 0.5);
  const unbanked = await q(`SELECT p.id, p.direction, p.party_id, p.amount, to_char(p.pay_date, 'YYYY-MM-DD') AS day FROM payments p
    WHERE NOT EXISTS (SELECT 1 FROM bank_lines b WHERE b.payment_id = p.id)`);
  const byName = (list: any[], desc: string) => {
    const dw = new Set(words(desc));
    const flat = String(desc).toUpperCase().replace(/[^A-Z]/g, "");
    let best: any = null, score = 0;
    for (const c of list) {
      const nw = words(c.name);
      let sc = nw.filter((w) => dw.has(w)).length * 2;
      const head = nw.join("").slice(0, 8);
      if (head.length >= 6 && flat.includes(head)) sc += 3;
      if (sc > score) { score = sc; best = c; }
    }
    return score >= 2 ? best : null;
  };
  const usedPay = new Set<number>();
  return lines.map((l) => {
    const credit = Number(l.credit) > 0;
    const amt = round2(credit ? Number(l.credit) : Number(l.debit));
    const dir = credit ? "in" : "out";
    const rule = rules[ruleKey(l.description)];
    // 1. a payment already typed in by hand for this amount (within a week)
    const same = unbanked.find((p) => !usedPay.has(p.id) && p.direction === dir && Math.abs(Number(p.amount) - amt) <= 1
      && Math.abs(daysBetween(p.day, l.txn_date)) <= 7);
    if (same) { usedPay.add(same.id); return { kind: "link", payment_id: same.id, party_id: same.party_id, why: "A payment for this amount is already entered" }; }
    // 2. customer / vendor by name, by a remembered rule, or by an exact bill amount
    const list = credit ? customers : vendors, bills = credit ? billsIn : billsOut;
    let party = rule && rule.kind === dir ? list.find((c) => c.id === rule.party_id) : null;
    let why = party ? "Same as last time" : "";
    if (!party) { party = byName(list, l.description); if (party) why = "Name found in the description"; }
    if (!party) {
      const hit = bills.find((b) => Math.abs(b.balance - amt) <= 1);
      if (hit) { party = list.find((c) => c.id === hit.party_id); why = `Amount matches ${hit.ref}`; }
    }
    if (party) {
      const m = matchAmount(bills.filter((b) => b.party_id === party.id), amt);
      return { kind: dir, party_id: party.id, allocations: m.pick, exact: m.exact, why };
    }
    // 3. bank charges, salary, taxes ... from the words in the description
    if (rule && (rule.kind === "expense" || rule.kind === "ignore")) return { kind: rule.kind, category: rule.category, why: "Same as last time" };
    const cat = guessCategory(l.description, credit);
    if (cat) return { kind: "expense", category: cat, why: "From the description" };
    return { kind: "", why: "" };
  });
}

route("GET", "/api/bank", async (c) => {
  require(c, "accounts");
  const status = new URL(c.req.url).searchParams.get("status") === "done" ? "done" : "new";
  const lines = await q(`SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, description, ref, debit, credit, balance, status, payment_id, expense_id, posted_as
    FROM bank_lines WHERE ${status === "new" ? "status = 'new'" : "status <> 'new'"} ORDER BY txn_date ${status === "new" ? "" : "DESC"}, id LIMIT 500`);
  const suggestions = status === "new" ? await bankSuggestions(lines) : [];
  return json({
    lines: lines.map((l, i) => ({ ...l, suggest: suggestions[i] || null })),
    customers: await q("SELECT id, name FROM customers WHERE active = 1 ORDER BY name"),
    vendors: await q("SELECT id, name FROM vendors WHERE active = 1 ORDER BY name"),
    categories: EXPENSE_CATEGORIES,
    bills: { in: (await billStatus("in")).rows.filter((b) => b.balance > 0.5), out: (await billStatus("out")).rows.filter((b) => b.balance > 0.5) },
  });
});

route("POST", "/api/bank/upload", async (c) => {
  require(c, "accounts", "edit");
  const rows = Array.isArray(c.body?.rows) ? c.body.rows.slice(0, 5000) : [];
  let added = 0, skipped = 0;
  for (const r of rows) {
    const day = isoDate(r.date);
    const debit = round2(Math.abs(num(r.debit) || 0)), credit = round2(Math.abs(num(r.credit) || 0));
    if (!day || (!debit && !credit)) { skipped++; continue; }
    const res = await q(`INSERT INTO bank_lines (txn_date, description, ref, debit, credit, balance, file_name, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
      [day, str(r.description).slice(0, 500), str(r.ref).slice(0, 100) || null, debit, credit, num(r.balance), str(c.body.file).slice(0, 200), c.user!.id]);
    if (res.length) added++; else skipped++;
  }
  return json({ added, skipped });
});

route("POST", "/api/bank/post", async (c) => {
  require(c, "accounts", "edit");
  const items = Array.isArray(c.body?.items) ? c.body.items : [];
  let done = 0;
  const errors: string[] = [];
  for (const it of items) {
    try {
      await tx(async (query) => {
        const l = (await query("SELECT *, to_char(txn_date, 'YYYY-MM-DD') AS day FROM bank_lines WHERE id = $1 FOR UPDATE", [num(it.id)]))[0];
        if (!l || l.status !== "new") return;
        const credit = Number(l.credit) > 0, amt = round2(credit ? Number(l.credit) : Number(l.debit)), dir = credit ? "in" : "out";
        const label = `${l.day} ${String(l.description).slice(0, 40)}`;
        let postedAs = "", payId: number | null = null, expId: number | null = null, status = "done";
        if (it.kind === "link") {
          const pay = (await query("SELECT p.*, COALESCE(c.name, v.name) AS pname FROM payments p LEFT JOIN customers c ON p.direction = 'in' AND c.id = p.party_id LEFT JOIN vendors v ON p.direction = 'out' AND v.id = p.party_id WHERE p.id = $1", [num(it.payment_id)]))[0];
          if (!pay || pay.direction !== dir) throw new Error(`${label}: that payment is not a match.`);
          payId = pay.id; postedAs = `Matched to payment entered earlier · ${pay.pname}`;
        } else if (it.kind === "in" || it.kind === "out") {
          if (it.kind !== dir) throw new Error(`${label}: money ${credit ? "received" : "paid"} cannot be posted the other way.`);
          const partyId = num(it.party_id);
          const party = partyId ? (await query(`SELECT id, name FROM ${dir === "in" ? "customers" : "vendors"} WHERE id = $1`, [partyId]))[0] : null;
          if (!party) throw new Error(`${label}: pick the ${dir === "in" ? "customer" : "vendor"}.`);
          const allocs = (Array.isArray(it.allocations) ? it.allocations : []).map((a: any) => ({ bill_id: num(a.id ?? a.bill_id), amount: round2(num(a.amount) || 0) }))
            .filter((a: any) => a.bill_id && a.amount > 0);
          if (allocs.reduce((t: number, a: any) => t + a.amount, 0) > amt + 0.01) throw new Error(`${label}: bills add up to more than the amount.`);
          payId = (await query("INSERT INTO payments (direction, party_id, pay_date, amount, mode, reference, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
            [dir, party.id, l.day, amt, payMode(l.description), l.ref || null, "Bank: " + String(l.description).slice(0, 200), c.user!.id]))[0].id;
          for (const a of allocs) await query("INSERT INTO payment_allocations (payment_id, bill_id, amount) VALUES ($1, $2, $3)", [payId, a.bill_id, a.amount]);
          postedAs = `${dir === "in" ? "Received from" : "Paid to"} ${party.name}${allocs.length ? "" : " (on account)"}`;
          const key = ruleKey(l.description);
          if (key) await query("INSERT INTO bank_rules (key, kind, party_id, category, updated_at) VALUES ($1, $2, $3, NULL, NOW()) ON CONFLICT (key) DO UPDATE SET kind = EXCLUDED.kind, party_id = EXCLUDED.party_id, category = NULL, updated_at = NOW()", [key, dir, party.id]);
        } else if (it.kind === "expense") {
          const cat = str(it.category);
          if (!EXPENSE_CATEGORIES.includes(cat)) throw new Error(`${label}: pick what this is.`);
          expId = (await query("INSERT INTO expenses (day, direction, category, amount, description, bank_line_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            [l.day, dir, cat, amt, String(l.description).slice(0, 300), l.id, c.user!.id]))[0].id;
          postedAs = cat;
          const key = ruleKey(l.description);
          if (key) await query("INSERT INTO bank_rules (key, kind, party_id, category, updated_at) VALUES ($1, 'expense', NULL, $2, NOW()) ON CONFLICT (key) DO UPDATE SET kind = 'expense', party_id = NULL, category = EXCLUDED.category, updated_at = NOW()", [key, cat]);
        } else if (it.kind === "ignore") {
          status = "ignored"; postedAs = "Ignored";
        } else return;
        await query("UPDATE bank_lines SET status = $1, payment_id = $2, expense_id = $3, posted_as = $4 WHERE id = $5", [status, payId, expId, postedAs, l.id]);
        done++;
      });
    } catch (e: any) { errors.push(e.message); }
  }
  return json({ done, errors });
});

route("POST", "/api/bank/undo/:id", async (c) => {
  require(c, "accounts", "edit");
  await tx(async (query) => {
    const l = (await query("SELECT * FROM bank_lines WHERE id = $1 FOR UPDATE", [Number(c.params.id)]))[0] || fail(404, "Not found");
    // a payment created from this line is removed; one that was typed in earlier and only matched is kept
    if (l.payment_id && String(l.posted_as || "").indexOf("Matched to payment") !== 0) await query("DELETE FROM payments WHERE id = $1", [l.payment_id]);
    if (l.expense_id) await query("DELETE FROM expenses WHERE id = $1", [l.expense_id]);
    await query("UPDATE bank_lines SET status = 'new', payment_id = NULL, expense_id = NULL, posted_as = NULL WHERE id = $1", [l.id]);
  });
  return json({ ok: true });
});

route("GET", "/api/expenses", async (c) => {
  require(c, "accounts");
  const sp = new URL(c.req.url).searchParams;
  const from = isoDate(sp.get("from")) || "1900-01-01", to = isoDate(sp.get("to")) || "2999-12-31";
  const rows = await q(`SELECT id, to_char(day, 'YYYY-MM-DD') AS day, direction, category, amount, description FROM expenses
    WHERE day BETWEEN $1 AND $2 ORDER BY day DESC, id DESC`, [from, to]);
  const byCat = await q(`SELECT category, direction, SUM(amount) AS total, COUNT(*) AS n FROM expenses WHERE day BETWEEN $1 AND $2
    GROUP BY category, direction ORDER BY total DESC`, [from, to]);
  return json({ rows, byCat });
});

// ---------------------------------------------------------------- handler
export default async (req: Request, _context?: Context) => {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  try {
    // Simple CSRF guard: browsers can't send this header cross-site without CORS permission.
    if (method !== "GET" && req.headers.get("x-requested-with") !== "ray-erp") fail(400, "Bad request");
    for (const [m, rx, fn] of routes) {
      if (m !== method) continue;
      const match = url.pathname.match(rx);
      if (!match) continue;
      const uid = await readSession(req);
      const user = uid ? await one<User>("SELECT * FROM users WHERE id = $1 AND active = 1", [uid]) : null;
      const perms = user ? await permissionsFor(user.role) : {};
      let body: any = {};
      if (method !== "GET" && (req.headers.get("content-type") || "").includes("application/json")) body = await req.json().catch(() => ({}));
      const params = Object.fromEntries(Object.entries(match.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      return await fn({ req, user, perms, params, body });
    }
    return json({ error: "Not found" }, 404);
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong on the server. Please try again." }, 500);
  }
};

export const config: Config = { path: "/api/*" };
