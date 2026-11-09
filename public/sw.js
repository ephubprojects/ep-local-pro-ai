/* EP Local Pro AI — Service Worker
   Handles background push notifications for Staff Radio. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(clients.claim()));

self.addEventListener('push', event => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); }
  catch { payload = { title: '📻 Staff Radio', body: event.data.text() }; }

  const {
    title = '📻 Staff Radio',
    body  = 'New voice message',
    url   = '/',
    tag   = 'wt-call'
  } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify:            true,
      requireInteraction:  true,
      vibrate:             [300, 100, 300, 100, 300],
      data:                { url }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.focus(); return; }
      }
      return clients.openWindow(url);
    })
  );
});
