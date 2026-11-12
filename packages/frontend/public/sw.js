// Shows a notice when the server pushes one, and opens Aman when it is tapped.
// It keeps no stored copies of anything and has no fetch handler, so /api/ and streaming responses always go straight
// to the network.
// A push carries only an item id and a short title. The page fetches the details after it opens.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title =
    typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'Something is waiting for you';
  const deliveryId = typeof payload.delivery_id === 'string' ? payload.delivery_id : '';
  const options = {
    data: { delivery_id: deliveryId },
    icon: new URL('icon-192.png', self.registration.scope).href,
  };
  // Without a tag a second notice for another item would replace the first.
  if (deliveryId !== '') {
    options.tag = deliveryId;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data;
  const deliveryId = data && typeof data.delivery_id === 'string' ? data.delivery_id : '';
  const target = new URL(self.registration.scope);
  if (deliveryId !== '') {
    target.searchParams.set('delivery', deliveryId);
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
      const open = windows.find(client => client.url.startsWith(self.registration.scope));
      if (open) {
        open.postMessage({ type: 'open_delivery', delivery_id: deliveryId });
        return open.focus();
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
