/* Oranosis v1 service worker: caches the app shell + model so the page works offline once visited. */
const CACHE = "oranosis-ea2fff7fdf";
const FILES = ["./", "index.html", "app.js", "oranosis.js", "app.css", "logo.svg", "model.json", "knowledge.json",
  "performance.json", "selftest.json", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("oranosis-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).catch(() =>
    e.request.mode === "navigate" ? caches.match("index.html") : Response.error())));
});
