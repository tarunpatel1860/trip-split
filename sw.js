/* Tiny offline shell. Network-first so deploys show up; cache is the fallback. */
var CACHE = 'trip-split-v1';
var SHELL = [
  './',
  './index.html',
  './logic.js',
  './config.js',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icon.svg',
  './admin/index.html',
  './admin/admin.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE;
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
    fetch(request).then(function (response) {
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
