const CACHE_NAME = "four-flavours-v2";

// Do NOT cache everything blindly during install. 
// We only cache the bare minimum to pass the PWA requirement.
self.addEventListener("install", (event) => {
  self.skipWaiting(); // Instantly activates the new service worker
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // It's safer to cache just the root to pass the PWA check.
      // If you add files here, a single 404 will break the entire installation.
      return cache.addAll(["/"]); 
    }).catch(err => console.log("Cache bypass: ", err))
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

// Chrome strictly requires a fetch handler to consider it a PWA
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});