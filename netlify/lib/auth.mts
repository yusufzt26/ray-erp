import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { one, q } from "./db.mts";

const COOKIE = "erp_session";
const MAX_AGE = 60 * 60 * 12; // 12 hours

let cachedSecret: string | null = null;

/** Signing secret: SESSION_SECRET env var if set, otherwise one generated once and kept in the database. */
async function secret(): Promise<string> {
  const env = (globalThis as any).Netlify?.env?.get?.("SESSION_SECRET") ?? process.env.SESSION_SECRET;
  if (env) return env;
  if (cachedSecret) return cachedSecret;
  await q("INSERT INTO settings (key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING", [
    randomBytes(32).toString("hex"),
  ]);
  cachedSecret = (await one<{ value: string }>("SELECT value FROM settings WHERE key='session_secret'"))!.value;
  return cachedSecret;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export async function makeSessionCookie(uid: number, secure: boolean) {
  const payload = b64(JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + MAX_AGE }));
  const sig = createHmac("sha256", await secret()).update(payload).digest("base64url");
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function readSession(req: Request): Promise<number | null> {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const expect = createHmac("sha256", await secret()).update(payload).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now() / 1000) return null;
    return Number(data.uid);
  } catch {
    return null;
  }
}
