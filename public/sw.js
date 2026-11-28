// Lets the ERP be installed as an app. Pages and data always come fresh from
// the server; the saved copy of the app files is used only when offline.
const CACHE = "ray-erp-v3";
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || new Response("You are offline. Connect to the internet and try again.", { status: 503, headers: { "content-type": "text/plain" } }))));
});

// ---- WhatsApp-style pop-up alerts (web push) ----
// If the app is open and on screen, the page shows its own pop-up with a sound;
// otherwise the phone / PC shows a system notification, even when the app is closed.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Ray Precicomp ERP", body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    if ("setAppBadge" in self.navigator && d.unread) self.navigator.setAppBadge(d.unread).catch(() => {});
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const seen = wins.find((w) => w.visibilityState === "visible" && w.focused);
    if (seen) { seen.postMessage({ type: "erp-notification", data: d }); return; }
    for (const w of wins) w.postMessage({ type: "erp-notification", data: d, quiet: true });
    await self.registration.showNotification(d.title || "Ray Precicomp ERP", {
      body: d.body || "", icon: "/icon-192.png", badge: "/badge-96.png", tag: "erp-" + (d.id || Date.now()),
      renotify: true, vibrate: [200, 100, 200], timestamp: Date.now(), data: { link: d.link || "#/" },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL("/" + (e.notification.data?.link || "#/"), self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (w) { w.postMessage({ type: "erp-open", link: e.notification.data?.link || "#/" }); return w.focus(); }
    return self.clients.openWindow(url);
  })());
});
