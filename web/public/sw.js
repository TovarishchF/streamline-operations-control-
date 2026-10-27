/*
 * Service worker веб-клиента (PWA, `SPEC.md § 10.1`, M10).
 *
 * Что кэшируется:
 * - оболочка приложения (`/`): при отсутствии сети открывается она,
 *   а не страница браузера «нет соединения»;
 * - сборка `/assets/*` и шрифты: имена файлов с хэшем содержимого,
 *   они неизменяемы и берутся из кэша;
 * - иконки и манифест.
 *
 * Что НЕ кэшируется — `/api/*`: данные диспетчерской устаревают за минуты,
 * и показать вчерашний статус рейса как сегодняшний хуже, чем честно
 * сообщить, что сервер недоступен. Офлайн-работа с данными — задача
 * мобильного приложения (`MOBILE.md`), а не этого кэша.
 */
/* global self, caches, fetch, URL, Response */
const VERSION = 'soc-shell-v1';
const SHELL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll([SHELL, '/manifest.webmanifest', '/icons/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isImmutable(url) {
  return url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Переход по адресу приложения: сначала сеть (новая сборка), без сети — оболочка.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(VERSION).then((cache) => cache.put(SHELL, copy));
          return response;
        })
        .catch(() => caches.match(SHELL).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  if (isImmutable(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
