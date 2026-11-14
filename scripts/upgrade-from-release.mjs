/**
 * Proves an install of the last release can move to this code without losing anything.
 *
 * The last release is started on a fresh data folder and filled with one of each thing a person
 * keeps. It is stopped, and this code is started on the same folder. Every one of those things
 * must still be there, and one more of each must save, so a table that upgrades only while it is
 * empty is caught.
 *
 * With no arguments the last release is the newest `vX.Y.Z` tag: it is checked out beside this
 * code, built and packed, and this code is packed as it is built now. `--from` and `--to` take
 * two tarballs that are already packed instead.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check, formPost, sessionCookie, shell, startPackedApp } from './packed-app.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMAIL = 'owner@example.com';
const PASSWORD = 'a long enough password';
const MODEL_NAME = 'openai/small';
const port = 18_791;

const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' } } });
check(
  (values.from === undefined) === (values.to === undefined),
  'Pass both --from <release tarball> and --to <new tarball>, or neither.',
);

function run({ command, args, cwd }) {
  return execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...shell });
}

/** Packs the app of one checkout, which must be built, and returns the tarball's path. */
async function pack({ cwd, packDir }) {
  run({ command: 'pnpm', args: ['--filter', 'amanuensis', 'pack', '--pack-destination', packDir], cwd });
  const [tarballName] = (await readdir(packDir)).filter(name => name.endsWith('.tgz'));
  check(tarballName !== undefined, `pnpm pack produced no tarball in ${packDir}`);
  return path.join(packDir, tarballName);
}

/** The newest release tag, by version. Tags of release candidates are not releases. */
function lastReleaseTag() {
  const tags = run({ command: 'git', args: ['tag', '--list', 'v*', '--sort=-v:refname'], cwd: rootDir })
    .split('\n')
    .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag));
  check(tags[0] !== undefined, 'This checkout has no release tag. Fetch the tags, then run this again.');
  return tags[0];
}

/** One signed-in person talking to the running app. */
function client({ origin, cookie }) {
  return async ({ method = 'GET', pathname, body }) => {
    const response = await globalThis.fetch(`${origin}${pathname}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };
}

/** Saves one thing and returns what the app answered, parsed. */
async function save({ api, what, method, pathname, body }) {
  const answer = await api({ method, pathname, body });
  check(
    answer.status >= 200 && answer.status < 300,
    `Saving ${what} answered ${String(answer.status)}: ${answer.text.slice(0, 400)}`,
  );
  return answer.text === '' ? {} : JSON.parse(answer.text);
}

/**
 * Saves one of each thing a person keeps, all named with `tag`, and returns where each one is
 * read back and the words that must be in that answer.
 */
async function fill({ api, tag }) {
  const kept = [];
  const keep = ({ what, pathname, words }) => kept.push({ what, pathname, words });

  await save({
    api,
    what: 'a skill',
    method: 'PUT',
    pathname: '/api/v1/settings/skills',
    body: {
      manifest: {
        type: 'git',
        name: `notes-${tag}`,
        url: 'https://github.com/example/daily-notes',
        ref: 'main',
        description: 'Fetches the notes for today.',
        network_hosts: ['notes.example.com'],
      },
    },
  });
  keep({ what: 'the skill', pathname: '/api/v1/settings/skills', words: `notes-${tag}` });

  await save({
    api,
    what: 'an agent',
    method: 'POST',
    pathname: '/api/v1/agents',
    body: {
      name: `helper-${tag}`,
      description: 'Answers questions.',
      manifest: { model: { name: MODEL_NAME }, instructions: 'Answer in one line.' },
    },
  });
  keep({ what: 'the agent', pathname: '/api/v1/agents', words: `helper-${tag}` });

  await save({
    api,
    what: 'a schedule',
    method: 'POST',
    pathname: '/api/v1/schedules',
    body: {
      name: `weekly-${tag}`,
      agent_name: `helper-${tag}`,
      manifest: { task: 'Say hello.', cron: '0 9 * * 1', timezone: 'UTC' },
    },
  });
  keep({ what: 'the schedule', pathname: '/api/v1/schedules', words: `weekly-${tag}` });

  await save({
    api,
    what: 'a persona',
    method: 'POST',
    pathname: '/api/v1/personas',
    body: {
      persona: {
        display_name: `Guide ${tag}`,
        aliases: [`guide-${tag}`],
        instructions: 'Speak plainly.',
        model_name: MODEL_NAME,
      },
    },
  });
  keep({ what: 'the persona', pathname: '/api/v1/personas', words: `Guide ${tag}` });

  await save({
    api,
    what: 'a folder of spaces',
    method: 'POST',
    pathname: '/api/v1/space-folders',
    body: { name: `Trips ${tag}` },
  });
  keep({ what: 'the folder of spaces', pathname: '/api/v1/space-folders', words: `Trips ${tag}` });

  // A space is saved against the revision of the list it was read from.
  const spaces = await api({ pathname: '/api/v1/spaces' });
  const revision = /"aggregate_revision":(\d+)/.exec(spaces.text)?.[1];
  check(revision !== undefined, `Reading spaces gave no revision (${String(spaces.status)}).`);
  await save({
    api,
    what: 'a space',
    method: 'POST',
    pathname: '/api/v1/spaces',
    body: {
      expected_aggregate_revision: Number(revision),
      space: { name: `Camping ${tag}`, purpose: 'Things to bring.', status: 'active', body: '- Tent' },
    },
  });
  keep({ what: 'the space', pathname: '/api/v1/spaces', words: `Camping ${tag}` });

  await save({
    api,
    what: 'a folder of chats',
    method: 'POST',
    pathname: '/api/v1/session-folders',
    body: { name: `Work ${tag}` },
  });
  keep({ what: 'the folder of chats', pathname: '/api/v1/session-folders', words: `Work ${tag}` });

  await save({
    api,
    what: 'a memory',
    method: 'POST',
    pathname: '/api/v1/memory/vault/import',
    body: { entries: [{ text: `Prefers the window seat ${tag}.` }] },
  });
  keep({ what: 'the memory', pathname: '/api/v1/memory/vault', words: `Prefers the window seat ${tag}.` });

  const chat = await save({
    api,
    what: 'a chat',
    method: 'POST',
    pathname: '/api/v1/sessions',
    body: { agent: { spec: { model: { name: MODEL_NAME }, instructions: 'Answer in one line.' } } },
  });
  const chatId = chat?.data?.id;
  check(typeof chatId === 'string', 'Saving a chat gave back no id.');
  keep({ what: 'the chat', pathname: `/api/v1/sessions/${chatId}`, words: chatId });

  return kept;
}

/** Saves what there is only one of, and returns where it is read back. */
async function fillOnce({ api }) {
  await save({
    api,
    what: 'a model provider',
    method: 'PUT',
    pathname: '/api/v1/settings/model-providers',
    body: {
      manifest: {
        type: 'openai',
        base_url: 'https://models.example.com/v1',
        auth: { api_key: 'stand-in-key-for-the-upgrade-check' },
        models: [{ model_id: 'small', name: 'small', properties: {} }],
      },
    },
  });
  await save({
    api,
    what: 'the profile',
    method: 'PUT',
    pathname: '/api/v1/personalization/profile',
    body: {
      profile: {
        assistant_name: 'Mannie',
        assistant_identity: null,
        user_profile: 'Likes short answers.',
        voice_guidance: null,
        pinned_preferences: ['Use metric units.'],
      },
    },
  });
  await save({
    api,
    what: 'the safety settings',
    method: 'PATCH',
    pathname: '/api/v1/user/settings/sentinel',
    body: { sandbox_without_asking: true },
  });
  return [
    { what: 'the model provider', pathname: '/api/v1/settings/model-providers', words: 'models.example.com' },
    { what: 'the profile', pathname: '/api/v1/personalization/profile', words: 'Use metric units.' },
    { what: 'the safety settings', pathname: '/api/v1/user/settings/sentinel', words: '"sandbox_without_asking":true' },
  ];
}

async function checkKept({ api, kept, when }) {
  for (const { what, pathname, words } of kept) {
    const answer = await api({ pathname });
    check(answer.status === 200, `${when}, reading ${what} answered ${String(answer.status)}.`);
    check(answer.text.includes(words), `${when}, ${what} is missing: "${words}" is not in ${pathname}.`);
  }
}

/** Pages a person opens that read tables the fill above does not touch. */
const OTHER_PAGES = [
  '/api/v1/user/reminders',
  '/api/v1/user/deliveries',
  '/api/v1/user/audit-log',
  '/api/v1/user/reach',
  '/api/v1/settings/mcp-servers',
  '/api/v1/capabilities',
];

const workDir = await mkdtemp(path.join(tmpdir(), 'amanuensis-upgrade-'));
const dataDir = path.join(workDir, 'data');
const releaseDir = path.join(workDir, 'release');
let releaseCheckedOut = false;
let app;
try {
  await mkdir(dataDir);
  let fromTarball = values.from === undefined ? undefined : path.resolve(values.from);
  let toTarball = values.to === undefined ? undefined : path.resolve(values.to);
  if (fromTarball === undefined || toTarball === undefined) {
    const tag = lastReleaseTag();
    console.log(`Building the last release, ${tag}.`);
    run({ command: 'git', args: ['worktree', 'add', '--detach', releaseDir, tag], cwd: rootDir });
    releaseCheckedOut = true;
    run({ command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: releaseDir });
    run({ command: 'pnpm', args: ['build'], cwd: releaseDir });
    fromTarball = await pack({ cwd: releaseDir, packDir: await mkdtemp(path.join(workDir, 'pack-release-')) });
    toTarball = await pack({ cwd: rootDir, packDir: await mkdtemp(path.join(workDir, 'pack-new-')) });
  }

  app = await startPackedApp({ tarballPath: fromTarball, dataDir, port });
  const created = await formPost({
    origin: app.origin,
    pathname: '/api/v1/auth/create-account',
    fields: { email: EMAIL, password: PASSWORD, password_confirm: PASSWORD },
  });
  await created.text();
  check(created.status === 302, `Creating the sign-in on the release answered ${String(created.status)}.`);
  const before = client({ origin: app.origin, cookie: sessionCookie(created) });
  const keptOnce = await fillOnce({ api: before });
  const kept = [...keptOnce, ...(await fill({ api: before, tag: 'before' }))];
  await checkKept({ api: before, kept, when: 'Before the upgrade' });
  console.log(`The release holds ${String(kept.length)} saved things.`);
  await app.stop();
  app = undefined;

  app = await startPackedApp({ tarballPath: toTarball, dataDir, port });
  const signedIn = await formPost({
    origin: app.origin,
    pathname: '/api/v1/auth/login',
    fields: { email: EMAIL, password: PASSWORD },
  });
  await signedIn.text();
  check(signedIn.status === 302, `After the upgrade, signing in answered ${String(signedIn.status)}.`);
  const after = client({ origin: app.origin, cookie: sessionCookie(signedIn) });
  await checkKept({ api: after, kept, when: 'After the upgrade' });
  for (const pathname of OTHER_PAGES) {
    const answer = await after({ pathname });
    check(answer.status === 200, `After the upgrade, ${pathname} answered ${String(answer.status)}.`);
  }
  const added = await fill({ api: after, tag: 'after' });
  await checkKept({ api: after, kept: [...kept, ...added], when: 'After saving more' });
  console.log(`Upgrade OK: all ${String(kept.length)} things kept, and ${String(added.length)} more saved.`);
} finally {
  try {
    await app?.stop();
  } finally {
    if (releaseCheckedOut) {
      run({ command: 'git', args: ['worktree', 'remove', '--force', releaseDir], cwd: rootDir });
    }
    await rm(workDir, { recursive: true, force: true });
  }
}
