import webpush from "web-push";
import { one, q } from "./db.mts";

// WhatsApp-style alerts. Every event goes into the notifications feed (the bell in the app)
// and is pushed as a pop-up to each phone / PC that turned notifications on, even when the
// app is closed. A user is told about events in the modules their role can view, never
// about their own actions, and not about kinds they muted.

/** Kinds of alert a user can mute, by module. */
export const NOTIFY_KINDS: Record<string, string> = {
  customer_po: "New sales orders",
  quotation: "New quotations",
  delivery_challan: "New delivery challans",
  sales_invoice: "New sales invoices",
  purchase_order: "New purchase orders",
  grn: "Goods received (GRN)",
  vendor_invoice: "New vendor invoices",
  accounts: "Payments received and made",
  production: "Production logged",
};

let keys: { publicKey: string; privateKey: string } | null = null;

/** VAPID keys for push: env vars if set, otherwise made once and kept in the database. */
export async function vapidKeys() {
  if (keys) return keys;
  const env = (k: string) => (globalThis as any).Netlify?.env?.get?.(k) ?? process.env[k];
  if (env("VAPID_PUBLIC_KEY") && env("VAPID_PRIVATE_KEY")) keys = { publicKey: env("VAPID_PUBLIC_KEY"), privateKey: env("VAPID_PRIVATE_KEY") };
  else {
    const made = webpush.generateVAPIDKeys();
    await q("INSERT INTO settings (key, value) VALUES ('vapid_keys', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(made)]);
    keys = JSON.parse((await one<{ value: string }>("SELECT value FROM settings WHERE key = 'vapid_keys'"))!.value);
  }
  return keys!;
}

/** Users who should hear about an event in this module. */
async function recipients(module: string, actorId: number | null, onlyUser: number | null) {
  if (onlyUser) return q("SELECT id, notif_seen_id, notif_off FROM users WHERE id = $1 AND active = 1", [onlyUser]);
  return q(`SELECT u.id, u.notif_seen_id, u.notif_off FROM users u
    WHERE u.active = 1 AND u.id <> $2 AND NOT ($1 = ANY(string_to_array(u.notif_off, ',')))
      AND (u.role = 'Admin' OR EXISTS (SELECT 1 FROM role_permissions p WHERE p.role = u.role AND p.module = $1 AND p.level <> 'none'))`,
    [module, actorId || 0]);
}

/** Modules whose alerts this user gets (role can view them, not muted). */
export function feedModules(role: string, perms: Record<string, string>, off: string) {
  const muted = new Set(off.split(",").filter(Boolean));
  return Object.keys(NOTIFY_KINDS).filter((m) => (role === "Admin" || (perms[m] && perms[m] !== "none")) && !muted.has(m));
}

export async function unreadCount(user: { id: number; role: string; notif_seen_id: number; notif_off: string }, perms: Record<string, string>) {
  const r = await one(`SELECT COUNT(*)::int AS n FROM notifications WHERE id > $1 AND
    (user_id = $2 OR (user_id IS NULL AND module = ANY($3) AND COALESCE(actor_id, 0) <> $2))`,
    [user.notif_seen_id || 0, user.id, feedModules(user.role, perms, user.notif_off || "")]);
  return r?.n || 0;
}

type Event = { module: string; title: string; body?: string; link?: string; actor?: number | null; onlyUser?: number | null };

/** Record an event and push it to every phone / PC of the people who should know. Never throws. */
export async function notify(e: Event) {
  try {
    if (!(e.module in NOTIFY_KINDS) && e.module !== "test") return;
    const row = await one(`INSERT INTO notifications (module, title, body, link, actor_id, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [e.module, e.title.slice(0, 200), (e.body || "").slice(0, 400) || null, e.link || null, e.actor || null, e.onlyUser || null]);
    const people = await recipients(e.module, e.actor || null, e.onlyUser || null);
    if (!people.length) return;
    const subs = await q("SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1)", [people.map((p) => p.id)]);
    if (!subs.length) return;
    const { publicKey, privateKey } = await vapidKeys();
    const unread: Record<number, number> = {};
    for (const p of people) {
      const r = await one(`SELECT COUNT(*)::int AS n FROM notifications WHERE id > $1 AND (user_id = $2 OR (user_id IS NULL AND COALESCE(actor_id,0) <> $2 AND module = ANY($3)))`,
        [p.notif_seen_id || 0, p.id, await modulesOf(p.id)]);
      unread[p.id] = r?.n || 0;
    }
    const send = subs.map(async (s) => {
      const payload = JSON.stringify({ id: row.id, title: e.title, body: e.body || "", link: e.link || "#/", unread: unread[s.user_id] || 0 });
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
          { vapidDetails: { subject: process.env.URL || "https://ray-precicomp-erp.netlify.app", publicKey, privateKey }, TTL: 60 * 60 * 24, urgency: "high", timeout: 5000 });
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) await q("DELETE FROM push_subscriptions WHERE id = $1", [s.id]); // phone unsubscribed
        else console.error("push failed", err?.statusCode || err?.message);
      }
    });
    await Promise.race([Promise.all(send), new Promise((r) => setTimeout(r, 6000))]);
  } catch (err) {
    console.error("notify failed", err);
  }
}

async function modulesOf(uid: number) {
  const u = await one("SELECT role, notif_off FROM users WHERE id = $1", [uid]);
  if (!u) return [];
  const perms: Record<string, string> = {};
  for (const r of await q("SELECT module, level FROM role_permissions WHERE role = $1", [u.role])) perms[r.module] = r.level;
  return feedModules(u.role, perms, u.notif_off || "");
}

export const rupees = (n: unknown) => "₹ " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
