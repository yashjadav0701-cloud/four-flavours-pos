const CACHE_NAME = "four-flavours-v6";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // STRICT BYPASS: Let the browser handle all network routing natively.
  // This prevents Vercel rewrite loops and Supabase WebSocket crashes
  // while satisfying Chrome's mandatory requirement for a fetch handler.
  if (event.request.method !== 'GET') return;
  return; 
});