import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');
const WORKER_SOURCE = readFileSync(join(PUBLIC_DIR, 'sw.js'), 'utf8');

type Listener = (event: Record<string, unknown>) => void;

/** Runs the worker in a sandbox with a recording stand-in for the browser's worker scope. */
function loadWorker() {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const messages: unknown[] = [];
  const scope = {
    registration: {
      scope: 'https://aman.example.test/',
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () =>
        Promise.resolve([] as { url: string; postMessage: (m: unknown) => void; focus: () => Promise<void> }[]),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
    skipWaiting: () => undefined,
    addEventListener: (name: string, listener: Listener) => {
      listeners.set(name, listener);
    },
  };
  vm.runInNewContext(WORKER_SOURCE, { self: scope, URL, console });
  return { listeners, shown, opened, messages, scope };
}

function pushEvent(payload: unknown) {
  const waits: Promise<unknown>[] = [];
  return {
    data: { json: () => payload },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    done: () => Promise.all(waits),
  };
}

test('the service worker never caches /api/ or streaming responses: it caches nothing and takes no fetch events', () => {
  const { listeners } = loadWorker();
  assert.equal(listeners.has('fetch'), false, 'no fetch handler, so every request goes straight to the network');
  assert.deepEqual([...listeners.keys()].sort(), ['activate', 'install', 'notificationclick', 'push']);
  assert.doesNotMatch(WORKER_SOURCE, /\bcaches\b/);
  assert.doesNotMatch(WORKER_SOURCE, /\bCache\b/);
  assert.doesNotMatch(WORKER_SOURCE, /respondWith/);
});

test('a push shows its short title and carries only the item id', async () => {
  const { listeners, shown } = loadWorker();
  const event = pushEvent({ delivery_id: 'abc', title: 'Reminder', text: 'Pick up the secret parcel' });
  listeners.get('push')?.(event);
  await event.done();

  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.title, 'Reminder');
  assert.equal(JSON.stringify(shown[0]?.options['data']), JSON.stringify({ delivery_id: 'abc' }));
  assert.doesNotMatch(JSON.stringify(shown), /parcel/);
});

test('a push that cannot be read still shows plain words, and names no assistant', async () => {
  const { listeners, shown } = loadWorker();
  const unreadable = {
    data: {
      json: () => {
        throw new Error('not json');
      },
    },
    waitUntil: () => undefined,
  };
  listeners.get('push')?.(unreadable);
  assert.equal(shown[0]?.title, 'Something is waiting for you');
});

test('tapping a notice opens the app at the item when no window is open', async () => {
  const { listeners, opened } = loadWorker();
  const waits: Promise<unknown>[] = [];
  listeners.get('notificationclick')?.({
    notification: { close: () => undefined, data: { delivery_id: 'abc' } },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);
  assert.deepEqual(opened, ['https://aman.example.test/?delivery=abc']);
});

test('tapping a notice focuses a window that is already open and tells it which item', async () => {
  const { listeners, scope } = loadWorker();
  const sent: unknown[] = [];
  let focused = false;
  scope.clients.matchAll = () =>
    Promise.resolve([
      {
        url: 'https://aman.example.test/sessions/1',
        postMessage: (message: unknown) => sent.push(message),
        focus: () => {
          focused = true;
          return Promise.resolve();
        },
      },
    ]);
  const waits: Promise<unknown>[] = [];
  listeners.get('notificationclick')?.({
    notification: { close: () => undefined, data: { delivery_id: 'abc' } },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);
  assert.equal(JSON.stringify(sent), JSON.stringify([{ type: 'open_delivery', delivery_id: 'abc' }]));
  assert.equal(focused, true);
});

test('the web app manifest lets an iPhone add Aman to the Home Screen, which push there needs', () => {
  const manifest: unknown = JSON.parse(readFileSync(join(PUBLIC_DIR, 'site.webmanifest'), 'utf8'));
  assert.ok(typeof manifest === 'object' && manifest !== null);
  assert.equal(Reflect.get(manifest, 'display'), 'standalone');
  assert.ok(typeof Reflect.get(manifest, 'start_url') === 'string');
  const icons: unknown = Reflect.get(manifest, 'icons');
  assert.ok(Array.isArray(icons));
  const sizes = icons.map(icon => (typeof icon === 'object' && icon !== null ? Reflect.get(icon, 'sizes') : undefined));
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  const html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
  assert.match(html, /rel="manifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
});
