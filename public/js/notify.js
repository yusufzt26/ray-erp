// WhatsApp-style alerts: a bell with an unread count, a list of recent events,
// pop-up cards with a sound while the app is open, and phone / PC notifications
// (web push) that arrive even when the app is closed.

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let api = null;
let lastId = null;          // newest notification already known (null = not loaded yet)
let unread = 0;
const toasted = new Set();  // ids already popped up, so push and polling don't both show one
let timer = null;

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(iso), today = new Date();
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return time;
  if (s < 2 * 86400 && new Date(today - 864e5).toDateString() === d.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + " " + time;
};

// ---- sound: a short two-note chime, made in the browser (no file to load)
let audio = null;
const unlockAudio = () => { try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === "suspended") audio.resume(); } catch { /* no audio */ } };
["click", "keydown", "touchstart"].forEach((ev) => addEventListener(ev, unlockAudio, { passive: true }));
function chime() {
  if (store.get("erp-sound") === "off") return;
  try {
    unlockAudio();
    if (!audio || audio.state !== "running") return;
    const t = audio.currentTime;
    [[880, 0], [1318.5, 0.13]].forEach(([f, at]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.25, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.35);
      o.connect(g).connect(audio.destination); o.start(t + at); o.stop(t + at + 0.4);
    });
  } catch { /* no audio */ }
  if (navigator.vibrate) try { navigator.vibrate([120, 60, 120]); } catch { /* not allowed */ }
}

// ---- pop-up cards while the app is open
function toastBox() {
  let box = document.getElementById("toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
  return box;
}
function toast(n, sound = true) {
  if (n.id && toasted.has(n.id)) return;
  if (n.id) toasted.add(n.id);
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<img src="/icon-192.png" alt=""><div><div class="t-top"><b>${h(n.title)}</b><span>now</span></div><div class="t-body">${h(n.body || "")}</div></div><button aria-label="Close">×</button>`;
  el.onclick = (e) => { if (e.target.tagName !== "BUTTON" && n.link) location.hash = n.link; close(); };
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 250); };
  el.querySelector("button").onclick = (e) => { e.stopPropagation(); close(); };
  toastBox().prepend(el);
  setTimeout(close, 7000);
  if (sound) chime();
}

// ---- bell
export const bellHtml = () => `<button class="bell" id="bell" aria-label="Notifications" title="Notifications">🔔<span class="bell-count" hidden></span></button>`;

function showCount() {
  const c = document.querySelector("#bell .bell-count");
  if (c) { c.hidden = !unread; c.textContent = unread > 99 ? "99+" : unread; }
  if ("setAppBadge" in navigator) (unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch(() => {});
}

async function poll(first = false) {
  if (!api) return;
  try {
    const r = await api("GET", `/api/notifications?after=${lastId ?? 0}`);
    unread = r.unread;
    if (lastId !== null && !first) r.rows.slice(0, 3).reverse().forEach((n) => toast(n, !document.hidden));
    if (r.rows.length) lastId = Math.max(lastId ?? 0, ...r.rows.map((n) => n.id));
    else lastId ??= r.seen;
    showCount();
  } catch { /* offline or logged out */ }
}

export function mountBell() {
  const bell = document.getElementById("bell");
  if (!bell) return;
  showCount();
  bell.onclick = (e) => { e.stopPropagation(); document.getElementById("notif-panel") ? closePanel() : openPanel(); };
}

function closePanel() { document.getElementById("notif-panel")?.remove(); }
document.addEventListener("click", (e) => { const p = document.getElementById("notif-panel"); if (p && !p.contains(e.target)) closePanel(); });
addEventListener("hashchange", closePanel);

function enableStrip(devices) {
  if (isIos() && !installed()) return `<div class="n-enable"><b>📱 Alerts on iPhone</b><span>Tap <b>Share ⬆</b> then <b>Add to Home Screen</b>. Open the ERP from the new icon, then turn on alerts here.</span></div>`;
  if (!pushSupported()) return `<div class="n-enable"><span>This browser cannot show pop-up alerts. Use Chrome, Edge or Safari.</span></div>`;
  if (Notification.permission === "denied") return `<div class="n-enable warn"><b>Alerts are blocked</b><span>Allow notifications for this site in the browser settings (the 🔒 next to the address), then reload.</span></div>`;
  if (Notification.permission !== "granted" || !devices) return `<div class="n-enable"><b>🔔 Get pop-up alerts on this ${/mobi|android|iphone/i.test(navigator.userAgent) ? "phone" : "PC"}</b><span>Like WhatsApp: a sound and a message even when the ERP is closed.</span><button class="btn primary small" id="n-on">Turn on</button></div>`;
  return "";
}

async function openPanel() {
  closePanel();
  const p = document.createElement("div");
  p.id = "notif-panel";
  p.innerHTML = `<div class="n-head"><b>Notifications</b></div><div class="n-list"><p class="muted" style="padding:1rem">Loading…</p></div>`;
  document.body.appendChild(p);
  let r;
  try { r = await api("GET", "/api/notifications"); } catch (e) { p.querySelector(".n-list").innerHTML = `<p class="muted" style="padding:1rem">${h(e.message)}</p>`; return; }
  const newest = r.rows[0]?.id || 0;
  const subscribed = pushSupported() && Notification.permission === "granted" && (await currentSub());
  p.innerHTML = `
    <div class="n-head"><b>Notifications</b><button class="linkish" id="n-gear" title="Alert settings">⚙ Settings</button></div>
    ${enableStrip(subscribed ? 1 : 0)}
    <div class="n-list">${r.rows.length ? r.rows.map((n) => `<a class="n-item ${n.id > r.seen ? "new" : ""}" href="${h(n.link || "#/")}">
        <div class="n-title">${h(n.title)}</div><div class="n-body">${h(n.body || "")}</div><div class="n-time">${ago(n.created_at)}</div></a>`).join("")
      : `<p class="muted n-empty">No alerts yet. New orders, invoices, payments and production entries by others will show here.</p>`}</div>
    <div class="n-settings" hidden>
      <div class="n-sub">Tell me about</div>
      ${r.kinds.map((k) => `<label class="n-kind"><input type="checkbox" value="${k.key}" ${k.on ? "checked" : ""}> ${h(k.label)}</label>`).join("")}
      <label class="n-kind"><input type="checkbox" id="n-sound" ${store.get("erp-sound") === "off" ? "" : "checked"}> Play a sound in the app</label>
      <div class="n-actions"><button class="btn small" id="n-test">Send me a test alert</button>
        ${subscribed ? '<button class="btn small" id="n-offdev">Stop alerts on this device</button>' : ""}</div>
      <p class="muted small">Pop-ups on: ${r.devices} device${r.devices === 1 ? "" : "s"}. You are not alerted about things you did yourself.</p>
    </div>`;
  if (newest > r.seen) { api("POST", "/api/notifications/seen", { upto: newest }).catch(() => {}); unread = 0; showCount(); }
  p.querySelector("#n-gear").onclick = () => { const s = p.querySelector(".n-settings"); s.hidden = !s.hidden; };
  p.querySelector("#n-on")?.addEventListener("click", async (e) => { e.target.disabled = true; await turnOn(); openPanel(); });
  p.querySelectorAll(".n-kind input[value]").forEach((cb) => cb.onchange = () =>
    api("PUT", "/api/notifications/prefs", { off: [...p.querySelectorAll(".n-kind input[value]")].filter((x) => !x.checked).map((x) => x.value) }));
  p.querySelector("#n-sound").onchange = (e) => store.set("erp-sound", e.target.checked ? "on" : "off");
  p.querySelector("#n-test").onclick = async (e) => { e.target.disabled = true; e.target.textContent = "Sent - watch for it"; await api("POST", "/api/notifications/test", {}); setTimeout(() => poll(), 1500); };
  p.querySelector("#n-offdev")?.addEventListener("click", async () => { await turnOff(); openPanel(); });
}

// ---- web push
const b64ToBytes = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
const deviceName = () => { const u = navigator.userAgent; return (/android/i.test(u) ? "Android" : /iphone|ipad/i.test(u) ? "iPhone" : /windows/i.test(u) ? "Windows PC" : /mac/i.test(u) ? "Mac" : "Device") + (/edg\//i.test(u) ? " · Edge" : /chrome/i.test(u) ? " · Chrome" : /firefox/i.test(u) ? " · Firefox" : /safari/i.test(u) ? " · Safari" : ""); };
async function currentSub() { try { return await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch { return null; } }

export async function turnOn() {
  if (!pushSupported()) return false;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) { const { key } = await api("GET", "/api/push/key"); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }); }
    await api("POST", "/api/push/subscribe", { subscription: sub.toJSON(), device: deviceName() });
    store.set("erp-notif-asked", "1");
    document.getElementById("notif-banner")?.remove();
    return true;
  } catch (e) { alert("Could not turn on alerts on this device: " + e.message); return false; }
}

async function turnOff() {
  const sub = await currentSub();
  if (sub) { await api("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
}

/** Before logging out: this device stops getting the user's alerts. */
export async function forgetDevice() {
  const sub = pushSupported() && (await currentSub());
  if (sub) await api("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
}

/** Banner on Home asking to turn alerts on, until done or closed. */
export function homeBanner() {
  if (store.get("erp-notif-asked") || !pushSupported() && !(isIos() && !installed())) return "";
  if (pushSupported() && Notification.permission !== "default") return "";
  const ios = isIos() && !installed();
  return `<div class="notif-banner" id="notif-banner"><span class="nb-icon">🔔</span><div><b>Get WhatsApp-style alerts</b>
    <span>${ios ? "On iPhone: tap Share ⬆ → Add to Home Screen, open the ERP from that icon, then press the 🔔 at the top." : "New orders, invoices, payments and production pop up on this device with a sound, even when the ERP is closed."}</span></div>
    ${ios ? "" : '<button class="btn primary small" id="nb-on">Turn on</button>'}<button class="nb-x" id="nb-x" aria-label="Close">×</button></div>`;
}
export function wireHomeBanner() {
  document.getElementById("nb-on")?.addEventListener("click", async (e) => { e.target.disabled = true; if (await turnOn()) toast({ title: "🔔 Alerts are on", body: "You will now get pop-ups on this device." }); else e.target.disabled = false; });
  document.getElementById("nb-x")?.addEventListener("click", () => { store.set("erp-notif-asked", "1"); document.getElementById("notif-banner")?.remove(); });
}

/** Start after login: load the count, keep it fresh, and listen for pushes while open. */
export async function startNotifications(apiFn) {
  api = apiFn;
  if (timer) return;
  await poll(true);
  timer = setInterval(() => { if (!document.hidden) poll(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "erp-notification") { if (!e.data.quiet) toast(e.data.data); else if (e.data.data?.id) toasted.add(e.data.data.id); poll(); }
      if (e.data?.type === "erp-open" && e.data.link) location.hash = e.data.link;
    });
    // Same phone, new login: move this device's alerts to whoever is signed in now.
    if (pushSupported() && Notification.permission === "granted") currentSub().then((sub) => sub && api("POST", "/api/push/subscribe", { subscription: sub.toJSON(), device: deviceName() }).catch(() => {}));
  }
}
export function stopNotifications() { clearInterval(timer); timer = null; api && (lastId = null); unread = 0; toasted.clear(); }
