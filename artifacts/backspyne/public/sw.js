// BackSpyne service worker.
//
// Keep this deliberately narrow: it exists so an operator opening the console on a flaky
// connection still gets the app shell, and nothing more. Requests are network-first, so a
// deployed change is what a reload sees; the cache is only a fallback when the network
// fails, and then only for navigation. Anything else (a JS chunk, an icon) that fails
// returns an explicit 504 instead of silently answering with HTML, because handing HTML to
// a script request breaks the bundle in a way that reads as a broken deployment.
const CACHE = 'backspyne-shell-v2';
const SHELL = ['./', './manifest.webmanifest', './logo.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).pathname.includes('/api/')) return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match('./');
        if (shell) return shell;
      }
      return new Response('Offline: this resource is not cached.', {
        status: 504,
        statusText: 'Gateway Timeout',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }),
  );
});
