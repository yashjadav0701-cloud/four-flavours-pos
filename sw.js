const CACHE_NAME = "four-flavours-v3";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Extremely minimal cache to prevent 404 installation failures
      return cache.addAll(["/"]); 
    }).catch(err => console.error("Cache bypass: ", err))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // CRITICAL FIX: Ignore non-HTTP requests (like wss:// from Supabase or chrome-extension://)
  // If we don't ignore these, the Service Worker crashes and Chrome aborts the PWA installation!
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});