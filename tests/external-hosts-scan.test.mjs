import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkRuntimeHosts,
  extractHosts,
  isLocalHost,
  readExternalHostsAllowlist,
  scanExternalHosts,
} from '../scripts/check-external-hosts.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORDER = path.join(repoRoot, 'scripts/record-outbound-hosts.mjs');

const FIXTURE_ALLOWLIST = {
  categories: {
    provider: { meaning: 'a model service the person configures', link_only: false },
    connector: { meaning: 'a service the person connects', link_only: false },
    docs_link: { meaning: 'opens in a new tab, never fetched', link_only: true },
  },
  allowed: [
    { host: 'api.openai.com', category: 'provider', reason: 'OpenAI, when the person adds a key.' },
    { host: 'lucide.dev', category: 'docs_link', reason: 'Icon source.' },
    { host: 'mcp.posthog.com', category: 'connector', reason: 'PostHog MCP preset.' },
    { host: 'unused.example-docs.org', category: 'docs_link', reason: 'Named nowhere.' },
  ],
  forbidden: [
    { host: 'truefoundry.com', reason: 'Upstream assets host.' },
    { host: 'trueforge.dev', reason: 'Upstream docs site.' },
    { host: 'fonts.googleapis.com', reason: 'Google Fonts.' },
    { host: 'posthog.com', reason: 'Telemetry.' },
  ],
};

function git(root, args) {
  const environment = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY',
  ]) {
    Reflect.deleteProperty(environment, name);
  }
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: environment });
}

function withFixtureRepo(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), 'aman-external-hosts-'));
  try {
    git(root, ['init', '--quiet']);
    const all = { 'scripts/external-hosts.allowlist.json': JSON.stringify(FIXTURE_ALLOWLIST), ...files };
    for (const [relPath, content] of Object.entries(all)) {
      mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
      writeFileSync(path.join(root, relPath), content);
    }
    git(root, ['add', '.']);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('passes an allowed fetch and an allowed docs link', () => {
  withFixtureRepo(
    {
      'packages/trueforge/src/model.ts': "const res = await fetch('https://api.openai.com/v1/models');\n",
      'packages/trueforge-ui/src/Credit.tsx': '<a href="https://lucide.dev/icons/broom" target="_blank">Icon</a>\n',
    },
    root => {
      const { findings, unusedHosts } = scanExternalHosts({ rootDirectory: root });
      assert.deepEqual(findings, []);
      assert.deepEqual(unusedHosts.sort(), ['mcp.posthog.com', 'unused.example-docs.org']);
    },
  );
});

test('scans the connector servers kept under mcp/', () => {
  withFixtureRepo(
    {
      'mcp/gmail/src/client.ts': "const res = await fetch('https://unlisted.example-mail.org/v1/messages');\n",
      'mcp/gmail/src/client.test.ts': "await fetch('https://only-in-a-test.example-mail.org/');\n",
    },
    root => {
      const { findings } = scanExternalHosts({ rootDirectory: root });
      assert.deepEqual(
        findings.map(({ file, line, host }) => `${file}:${String(line)} ${host}`),
        ['mcp/gmail/src/client.ts:1 unlisted.example-mail.org'],
      );
    },
  );
});

test('fails a docs-link host that is fetched', () => {
  withFixtureRepo(
    {
      'packages/trueforge-ui/src/Icon.tsx': "const svg = await fetch('https://lucide.dev/icons/broom.svg');\n",
      'packages/frontend/index.html': '<head>\n  <script src="https://lucide.dev/x.js"></script>\n</head>\n',
    },
    root => {
      const { findings } = scanExternalHosts({ rootDirectory: root });
      assert.deepEqual(
        findings.map(({ file, line, host }) => `${file}:${String(line)} ${host}`),
        ['packages/frontend/index.html:2 lucide.dev', 'packages/trueforge-ui/src/Icon.tsx:1 lucide.dev'],
      );
      assert.match(findings[0].reason, /listed as docs_link .*but here it is loaded\. Link to it instead/);
    },
  );
});

test('fails the two removed upstream URLs by name, so they cannot come back unnoticed', () => {
  withFixtureRepo(
    {
      'packages/trueforge/src/apis/agentCodeSnippets.ts':
        "const TYPESCRIPT_ICON = 'https://assets.production.truefoundry.com/typescript.svg';\n",
      'packages/trueforge-ui/src/atoms/agent-details/AgentCodeSnippets.tsx':
        '          <a\n            href="https://trueforge.dev/api/use-agent"\n',
      'packages/trueforge-ui/src/theme/ensureStyles.ts':
        "link.href = 'https://fonts.googleapis.com/css2?family=Google+Sans';\n",
    },
    root => {
      const { findings } = scanExternalHosts({ rootDirectory: root });
      assert.deepEqual(
        findings.map(({ file, line, host }) => `${file}:${String(line)} ${host}`),
        [
          'packages/trueforge-ui/src/atoms/agent-details/AgentCodeSnippets.tsx:2 trueforge.dev',
          'packages/trueforge-ui/src/theme/ensureStyles.ts:1 fonts.googleapis.com',
          'packages/trueforge/src/apis/agentCodeSnippets.ts:1 assets.production.truefoundry.com',
        ].sort(),
      );
      for (const finding of findings) {
        assert.match(finding.reason, /must never appear in Aman: .* Remove it\.$/);
      }
    },
  );
});

test('a forbidden domain covers its subdomains unless one is allowed by exact name', () => {
  withFixtureRepo(
    {
      'packages/trueforge/catalog/mcp-catalog.yaml': 'url: https://mcp.posthog.com/mcp\n',
      'packages/trueforge-ui/src/analytics.ts': "fetch('https://us.i.posthog.com/capture');\n",
    },
    root => {
      const { findings } = scanExternalHosts({ rootDirectory: root });
      assert.deepEqual(
        findings.map(({ host }) => host),
        ['us.i.posthog.com'],
      );
    },
  );
});

test('fails a host missing from the list with the add-or-remove message', () => {
  withFixtureRepo(
    { 'ops/browser-sidecar/server.mjs': "const res = await fetch('https://tracker.example-cdn.net/pixel');\n" },
    root => {
      const { findings } = scanExternalHosts({ rootDirectory: root });
      assert.deepEqual(findings, [
        {
          file: 'ops/browser-sidecar/server.mjs',
          line: 1,
          host: 'tracker.example-cdn.net',
          reason:
            'tracker.example-cdn.net is not on the reviewed list of outside hosts. Add it to scripts/external-hosts.allowlist.json with a reason, or remove it.',
        },
      ]);
    },
  );
});

test('skips tests, docs, demo and lockfiles, which never ship', () => {
  withFixtureRepo(
    {
      'packages/trueforge/tests/unit/x.test.ts': "fetch('https://tracker.example-cdn.net');\n",
      'packages/trueforge/src/x.test.ts': "fetch('https://tracker.example-cdn.net');\n",
      'packages/trueforge/src/README.md': 'https://tracker.example-cdn.net\n',
      'demo/seed.mjs': "fetch('https://tracker.example-cdn.net');\n",
      'docs/page.mdx': 'https://tracker.example-cdn.net\n',
      'ops/calendar-sidecar/package-lock.json': '"resolved": "https://tracker.example-cdn.net/x.tgz"\n',
    },
    root => {
      assert.deepEqual(scanExternalHosts({ rootDirectory: root }).findings, []);
    },
  );
});

test('extracts bare hosts handed to a connection, and protocol-relative loads', () => {
  const hosts = extractHosts(
    [
      "imap_host: 'imap.mail.example-mail.org',",
      "socket.connect('smtp.example-mail.org', 465);",
      '<img src="//cdn.example-cdn.net/a.png">',
      "const name = 'not.a.host.tsx';",
      'const doc = `https://api.example-api.org${path}`;',
      'const tpl = `https://${host}/x`;',
    ].join('\n'),
  );
  assert.deepEqual(hosts, [
    { line: 1, host: 'imap.mail.example-mail.org', context: 'reference' },
    { line: 2, host: 'smtp.example-mail.org', context: 'fetch' },
    { line: 3, host: 'cdn.example-cdn.net', context: 'fetch' },
    { line: 5, host: 'api.example-api.org', context: 'reference' },
  ]);
});

test('local and private names are not outside hosts', () => {
  for (const host of [
    'localhost',
    'aman-stt',
    'host.docker.internal',
    'x.invalid',
    'a.example.com',
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.20',
    '::1',
  ]) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of ['api.openai.com', '8.8.8.8', 'example-cdn.net']) {
    assert.equal(isLocalHost(host), false, host);
  }
});

test('runtime check fails a link-only or unlisted host that was contacted', () => {
  withFixtureRepo({}, root => {
    const browserLog = path.join(root, 'browser.jsonl');
    const serverLog = path.join(root, 'server.jsonl');
    writeFileSync(
      browserLog,
      [
        'http://localhost:8000/',
        'data:image/png;base64,AA',
        'https://lucide.dev/x.svg',
        'https://fonts.googleapis.com/css2',
      ]
        .map(url => JSON.stringify({ url }))
        .join('\n'),
    );
    writeFileSync(
      serverLog,
      ['api.openai.com', 'postgres', 'tracker.example-cdn.net'].map(host => JSON.stringify({ host })).join('\n'),
    );
    const { findings } = checkRuntimeHosts({ rootDirectory: root, browserLog, serverLog });
    assert.deepEqual(
      findings.map(({ file, host }) => `${file} ${host}`),
      ['browser lucide.dev', 'browser fonts.googleapis.com', 'server tracker.example-cdn.net'],
    );
  });
});

test('the outbound recorder logs each host the process looks up or dials', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aman-outbound-'));
  try {
    const log = path.join(dir, 'outbound.jsonl');
    const script = [
      "import dns from 'node:dns';",
      "import net from 'node:net';",
      "await dns.promises.lookup('lookup.recorder-test.invalid').catch(() => {});",
      "await fetch('https://fetch.recorder-test.invalid/').catch(() => {});",
      "net.connect({ host: '203.0.113.7', port: 9 }).on('error', () => {}).destroy();",
    ].join('\n');
    const result = spawnSync(process.execPath, ['--import', RECORDER, '--input-type=module', '-e', script], {
      env: { ...process.env, AMAN_OUTBOUND_HOSTS_LOG: log },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const hosts = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).host);
    assert.ok(hosts.includes('lookup.recorder-test.invalid'), hosts.join(','));
    assert.ok(hosts.includes('fetch.recorder-test.invalid'), hosts.join(','));
    assert.ok(hosts.includes('203.0.113.7'), hosts.join(','));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the repository passes its own scan, and the list stays the real list', () => {
  const allowlist = readExternalHostsAllowlist({ rootDirectory: repoRoot });
  for (const entry of allowlist.allowed.values()) {
    assert.ok(allowlist.categories.has(entry.category), entry.host);
  }
  const { findings, unusedHosts } = scanExternalHosts({ rootDirectory: repoRoot });
  assert.deepEqual(findings, []);
  assert.deepEqual(unusedHosts, []);
});
