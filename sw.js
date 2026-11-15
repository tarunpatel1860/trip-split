/* Tiny offline shell. Network-first so deploys show up; cache is the fallback. */
/* Bump CACHE on every deploy. It is what triggers the in-app update prompt. */
var CACHE = 'trip-split-v6';
var SHELL = [
  './',
  './index.html',
  './logic.js',
  './config.js',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './admin/index.html',
  './admin/admin.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    })
  );
});

/* The page asks us to take over when the user taps "Update". */
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE && key.indexOf('trip-split-') === 0;
      }).map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  var isAdmin = /\/admin(\/|$)/.test(url.pathname);

  event.respondWith(
    fetch(request, { cache: 'no-cache' }).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function () {
      return caches.match(request).then(function (cached) {
        if (cached) return cached;
        return caches.match(isAdmin ? './admin/index.html' : './index.html');
      });
    })
  );
});
