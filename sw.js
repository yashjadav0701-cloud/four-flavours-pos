const CACHE_NAME = 'four-flavours-v1';

// Install event - skips waiting to ensure the latest version is always active immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate event - claims the clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Fetch event - THIS IS THE CRITICAL MISSING PIECE FOR PWA INSTALLATION.
// We use a network-first pass-through strategy so we don't accidentally cache dynamic POS data.
self.addEventListener('fetch', (event) => {
  // Ignore API calls to Supabase, let them pass through normally
  if (event.request.url.includes('supabase.co')) {
    return;
  }
  
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});