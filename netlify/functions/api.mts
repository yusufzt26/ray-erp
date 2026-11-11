import type { Config, Context } from "@netlify/functions";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { DOC_TYPES, LEVELS, MASTERS, MODULES, PRODUCT_CATEGORIES, ROLES, coerce } from "../../public/js/fields.js";
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
const DOC_COLS = "id, doc_type, ref_no, doc_no, to_char(doc_date, 'YYYY-MM-DD') AS doc_date, party_id, party_name, party_gstin, to_char(delivery_date, 'YYYY-MM-DD') AS delivery_date, subtotal, tax_amount, total_amount, notes, pdf_file, status, created_at";

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
    if (!str(b.doc_no) || !partyName) fail(400, `${d.noLabel} and ${d.partyLabel} are required.`);

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
    const dup = (await query("SELECT ref_no FROM documents WHERE doc_type = $1 AND doc_no = $2 AND party_name = $3 AND id <> $4",
      [type, header.doc_no, partyName, did || 0]))[0];
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
      const all: any = { ...header, doc_type: type, ref_no: refNo, pdf_file: pdfFile || null, created_by: c.user!.id };
      const ks = Object.keys(all);
      id = (await query(`INSERT INTO documents (${ks.join(", ")}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        Object.values(all)))[0].id;
    }
    for (let i = 0; i < lines.length; i++)
      await query(`INSERT INTO document_lines (document_id, line_no, product_id, party_part_no, description, hsn, qty, uom, rate, amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [id, i + 1, ...lines[i]]);
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
  subtotal, cgst, sgst, igst, total, delivery_condition, payment_terms, packing, status, created_at`;
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
  return json({ rows: await q(sql + " ORDER BY i.id DESC", params) });
});

route("GET", "/api/invoices/options", async (c) => {
  require(c, "sales_invoice");
  const customers = await q("SELECT * FROM customers WHERE active = 1 ORDER BY name");
  const products = await q("SELECT id, code, name, customer_part_no, drawing_no, uom, hsn, sale_rate, gst_rate FROM products WHERE active = 1 AND sellable = 1 ORDER BY code");
  const pos = await q("SELECT id, ref_no, doc_no, to_char(doc_date, 'YYYY-MM-DD') AS doc_date, party_id, party_name, status FROM documents WHERE doc_type = 'customer_po' AND status NOT IN ('Completed', 'Cancelled') ORDER BY id DESC LIMIT 300");
  return json({ customers, products, pos });
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
    return { id: invId, inv_no: invNo };
  });
  return json(res);
});

route("DELETE", "/api/invoices/:id", async (c) => {
  if (c.user?.role !== "Admin") fail(403, "Only Admin can delete an invoice. Others can mark it Cancelled.");
  await q("DELETE FROM invoices WHERE id = $1", [Number(c.params.id)]);
  return json({ message: "Invoice deleted." });
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
