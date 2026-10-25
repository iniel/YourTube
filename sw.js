const BUILD_VERSION = "__BUILD_VERSION__";
const CACHE_NAME = `yourtube-shell-${BUILD_VERSION}`;
const SHELL_FILES = [
  "index.html",
  "style.css",
  "app.js",
  "short-history.mjs",
  "video-actions.mjs",
  "daily-archive.mjs",
  "local-feed.mjs",
  "float.html",
  "config.json",
];

const scopeUrl = new URL(self.registration.scope);
const shellPaths = new Map(SHELL_FILES.map((file) => [new URL(file, scopeUrl).pathname, file]));
shellPaths.set(scopeUrl.pathname, "index.html");

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: "reload" bypasses the HTTP cache so a new worker never precaches stale Pages responses (max-age=600).
      cache.addAll(SHELL_FILES.map((file) => new Request(file, { cache: "reload" }))),
    ),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("yourtube-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scopeUrl.origin) return;
  const shellFile = shellPaths.get(url.pathname);
  if (!shellFile) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => (await cache.match(shellFile)) || fetch(request)),
  );
});
