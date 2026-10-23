import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createStateStore,
  parseRegistry,
  parseRelease,
  registryValue,
  releaseIsReadable,
  renderRegistry,
  renderRelease,
  withRegistryValue,
  type ReleaseRecord,
  type StateBackend,
} from '../../src/state/state.ts';

test('a registry file parses to its lines in order', () => {
  const entries = parseRegistry('name=main\napp_port=8791\nhealthy=1\n');
  assert.deepEqual(entries, [
    { key: 'name', value: 'main' },
    { key: 'app_port', value: '8791' },
    { key: 'healthy', value: '1' },
  ]);
});

test('a registry value may itself contain an equals sign', () => {
  const entries = parseRegistry('origins=http://example.com/?a=b\n');
  assert.equal(registryValue(entries, 'origins'), 'http://example.com/?a=b');
});

test('the first line of a key wins, as with the shell reader', () => {
  const entries = parseRegistry('healthy=0\nhealthy=1\n');
  assert.equal(registryValue(entries, 'healthy'), '0');
  assert.equal(registryValue(entries, 'missing'), null);
});

test('a line with no key survives a round trip untouched', () => {
  const entries = parseRegistry('name=main\na stray line\n');
  assert.equal(renderRegistry(entries), 'name=main\na stray line\n');
});

test('setting a value replaces its line where it stands and keeps the others', () => {
  const entries = parseRegistry('name=main\nhealthy=0\nsandbox=slots\n');
  const next = withRegistryValue(entries, 'healthy', '1');
  assert.equal(renderRegistry(next), 'name=main\nhealthy=1\nsandbox=slots\n');
});

test('setting a new key adds it at the end', () => {
  const entries = parseRegistry('name=main\n');
  const next = withRegistryValue(entries, 'tls', 'local');
  assert.equal(renderRegistry(next), 'name=main\ntls=local\n');
});

const RELEASE_TEXT = `{
  "schema": "1",
  "source_ref": "abc123",
  "app_image": "aman-app:abc123",
  "stt_image": "aman-stt:abc123",
  "calendar_image": "aman-calendar-caldav:abc123",
  "dex_image": "ghcr.io/example/dex@sha256:aaaa",
  "mail_email_image": "ghcr.io/example/mail@sha256:bbbb"
}
`;

test('a release record parses and renders back to the same text', () => {
  const record = parseRelease(RELEASE_TEXT);
  assert.ok(record !== null);
  assert.equal(record.appImage, 'aman-app:abc123');
  assert.equal(renderRelease(record), RELEASE_TEXT);
});

test('text that is not a release record parses to null', () => {
  assert.equal(parseRelease('not json'), null);
  assert.equal(parseRelease('[1,2]'), null);
  assert.equal(parseRelease('"just a string"'), null);
});

test('a release record is readable only when the app, speech and sign-in images are named', () => {
  const full = parseRelease(RELEASE_TEXT);
  assert.ok(full !== null);
  assert.equal(releaseIsReadable(full), true);
  const partial: ReleaseRecord = { ...full, dexImage: null };
  assert.equal(releaseIsReadable(partial), false);
});

function memoryBackend(initial: Map<string, string>): StateBackend & { files: Map<string, string> } {
  const files = new Map(initial);
  return {
    files,
    readText: path => Promise.resolve(files.get(path) ?? null),
    listNames: dir => {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) {
          const first = path.slice(prefix.length).split('/')[0];
          if (first !== undefined && first !== '') {
            names.add(first);
          }
        }
      }
      return Promise.resolve([...names]);
    },
    writeChangedFiles: changed => {
      for (const file of changed) {
        files.set(file.path, file.text);
      }
      return Promise.resolve();
    },
    removeFile: path => {
      files.delete(path);
      return Promise.resolve();
    },
  };
}

test('writing an instance writes its registry file once, then reports no change', async () => {
  const backend = memoryBackend(new Map());
  const store = createStateStore(backend);
  const record = { name: 'main', entries: parseRegistry('name=main\nhealthy=0\n') };
  assert.equal(await store.writeInstance(record), true);
  assert.equal(backend.files.get('state/instances/main.conf'), 'name=main\nhealthy=0\n');
  assert.equal(await store.writeInstance(record), false);
});

test('setting one instance value keeps the rest of the registry file', async () => {
  const backend = memoryBackend(new Map([['state/instances/main.conf', 'name=main\nhealthy=0\n']]));
  const store = createStateStore(backend);
  assert.equal(await store.setInstanceValue({ name: 'main', key: 'healthy', value: '1' }), true);
  assert.equal(backend.files.get('state/instances/main.conf'), 'name=main\nhealthy=1\n');
  assert.equal(await store.setInstanceValue({ name: 'main', key: 'healthy', value: '1' }), false);
});

test('removing an instance removes its registry file', async () => {
  const backend = memoryBackend(new Map([['state/instances/main.conf', 'name=main\n']]));
  const store = createStateStore(backend);
  await store.removeInstance('main');
  assert.equal(backend.files.has('state/instances/main.conf'), false);
});

test('an instance name the registry cannot hold is refused', async () => {
  const store = createStateStore(memoryBackend(new Map()));
  await assert.rejects(async () => {
    await store.writeInstance({ name: '../escape', entries: [] });
  });
  await assert.rejects(async () => {
    await store.removeInstance('UPPER');
  });
});

test('writing a release keeps the old record as the previous one', async () => {
  const backend = memoryBackend(new Map([['release/release.json', RELEASE_TEXT]]));
  const store = createStateStore(backend);
  const current = parseRelease(RELEASE_TEXT);
  assert.ok(current !== null);
  assert.equal(await store.writeRelease(current), false);
  const next: ReleaseRecord = { ...current, appImage: 'aman-app:def456' };
  assert.equal(await store.writeRelease(next), true);
  assert.equal(backend.files.get('release/previous.release.json'), RELEASE_TEXT);
  assert.equal(backend.files.get('release/release.json'), renderRelease(next));
});

test('the summary reads the registry, the release records and the backup list', async () => {
  const backend = memoryBackend(
    new Map<string, string>([
      ['state/instances/main.conf', 'name=main\npublic_url=http://127.0.0.1:8791\n'],
      ['state/instances/guest.conf', 'name=guest\n'],
      ['release/release.json', RELEASE_TEXT],
      ['backups/20261020T030405Z/release.json', RELEASE_TEXT],
      ['state/backups', 'daily\n'],
      ['state/source', '/opt/aman-checkout\n'],
      ['state/installed', '2026-10-20T03:04:05Z aman-app:abc123\n'],
    ]),
  );
  const store = createStateStore(backend);
  const summary = await store.readSummary();
  assert.deepEqual(
    summary.instances.map(instance => instance.name),
    ['guest', 'main'],
  );
  assert.equal(summary.release?.appImage, 'aman-app:abc123');
  assert.equal(summary.releaseUnreadable, false);
  assert.deepEqual(summary.backups, ['20261020T030405Z']);
  assert.equal(summary.backupsMode, 'daily');
  assert.equal(summary.sourceCheckout, '/opt/aman-checkout');
  assert.equal(summary.installedAppImage, 'aman-app:abc123');
});

test('a release file that cannot be read marks the summary unreadable', async () => {
  const backend = memoryBackend(new Map<string, string>([['release/release.json', '{"app_image": 3}']]));
  const store = createStateStore(backend);
  const summary = await store.readSummary();
  assert.equal(summary.releaseUnreadable, true);
});
