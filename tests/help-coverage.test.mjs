import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkHelpCoverage,
  defaultSources,
  NO_TOPIC_NEXT_STEP,
  readInstallerCommands,
  readSettingsPanels,
} from '../scripts/check-help-coverage.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SETTINGS = `
const baseSections = [
  { id: 'models', label: 'Models', icon: 'cpu' },
  { id: 'about', label: 'About', icon: 'info' },
];
`;
const EMAIL = `export const EMAIL_PROVIDER_PRESETS: readonly EmailProviderPreset[] = [
  {
    key: 'gmail',
    name: 'Gmail',
  },
];
`;
const CALENDAR = `export const CALDAV_OTHER_PROVIDER_KEY = 'other';
export const CALDAV_PROVIDER_PRESETS: readonly CaldavProviderPreset[] = [
  {
    key: CALDAV_OTHER_PROVIDER_KEY,
    name: 'Other',
  },
];
`;
const TOUR = `export type TourCapabilities = { email: boolean };
export const CARDS = { brief: { title: 'Your morning brief' } };
export const HOME_TOPIC_IDS = ['behind'] as const;
`;
const APPROVALS = `export type SentinelApprovalCard = {
  plain_what: string;
  email: SentinelApprovalEmail | null;
};
`;
const CLI = "if (first === 'status') {}\n";
const SHELL = `# ---------------------------------------------------------------- main

case "\${1:-}" in
  doctor) shift ;;
  backup | upgrade) run_installer "$@" ;;
  *) die_usage "Unknown command: \${1:-(none)}" ;;
esac
`;

const ALL_SURFACES = [
  'settings:models',
  'settings:about',
  'email-preset:gmail',
  'calendar-preset:other',
  'tour:brief',
  'pill:behind',
  'approval:plain',
  'approval:email',
  'command:backup',
  'command:doctor',
  'command:status',
  'command:upgrade',
  'route:help',
];

function topic({ id, covers }) {
  return `---\nid: ${id}\ntitle: Title ${id}\ncovers: ${covers}\n---\nPlain words.\n`;
}

/** A small repository with one of each surface. `covers` lists what the one topic covers. */
async function fixture({ covers, coverage }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'help-coverage-'));
  const write = async (relative, text) => {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), text);
  };
  await write('settings.tsx', SETTINGS);
  await write('email.ts', EMAIL);
  await write('calendar.ts', CALENDAR);
  await write('tourPrompts.ts', TOUR);
  await write('types.ts', APPROVALS);
  await write('cli.ts', CLI);
  await write('aman', SHELL);
  await write('routes/helpRoutes.ts', '');
  await write('routes/openapiTags.ts', '');
  await write('topics/a.md', topic({ id: 'a', covers }));
  await mkdir(path.join(dir, 'docs'));
  await write('coverage.json', JSON.stringify(coverage));
  const sources = {
    settingsPath: path.join(dir, 'settings.tsx'),
    emailPresetsPath: path.join(dir, 'email.ts'),
    calendarPresetsPath: path.join(dir, 'calendar.ts'),
    tourPath: path.join(dir, 'tourPrompts.ts'),
    approvalTypesPath: path.join(dir, 'types.ts'),
    installerCliPath: path.join(dir, 'cli.ts'),
    installerShellPath: path.join(dir, 'aman'),
    routesDir: path.join(dir, 'routes'),
    topicsDir: path.join(dir, 'topics'),
    docsDir: path.join(dir, 'docs'),
    coveragePath: path.join(dir, 'coverage.json'),
  };
  return { dir, sources };
}

async function withFixture(input, run) {
  const fx = await fixture(input);
  try {
    return await run(fx.sources);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
}

const allButAbout = ALL_SURFACES.filter(surface => surface !== 'settings:about')
  .map(surface => (surface.startsWith('tour:') ? surface.slice('tour:'.length) : surface))
  .join(', ');

test('every surface in this repository has a topic or a reasoned exemption', async () => {
  const { problems } = await checkHelpCoverage(defaultSources(repoRoot));
  assert.deepEqual(problems, []);
});

test('reads one of each surface from the code', async () => {
  await withFixture({ covers: '', coverage: {} }, async sources => {
    const { surfaces } = await checkHelpCoverage(sources);
    assert.deepEqual(surfaces, ALL_SURFACES);
  });
});

test('an uncovered Settings panel fails with its name and the next step', async () => {
  await withFixture({ covers: allButAbout, coverage: {} }, async sources => {
    const { problems } = await checkHelpCoverage(sources);
    assert.deepEqual(problems, [`"settings:about" has no help topic. ${NO_TOPIC_NEXT_STEP}`]);
  });
});

test('an exemption with a reason passes', async () => {
  const coverage = { exempt: { 'settings:about': 'Shows the version only.' } };
  await withFixture({ covers: allButAbout, coverage }, async sources => {
    assert.deepEqual((await checkHelpCoverage(sources)).problems, []);
  });
});

test('a mapping in coverage.json covers a surface too', async () => {
  const coverage = { covers: { 'settings:about': ['a'] } };
  await withFixture({ covers: allButAbout, coverage }, async sources => {
    assert.deepEqual((await checkHelpCoverage(sources)).problems, []);
  });
});

test('an exemption with no reason fails', async () => {
  const coverage = { exempt: { 'settings:about': ' ' } };
  await withFixture({ covers: allButAbout, coverage }, async sources => {
    assert.deepEqual((await checkHelpCoverage(sources)).problems, [
      'coverage.json exempts "settings:about" with no reason. Add a one-line reason.',
    ]);
  });
});

test('a stale row, an exemption next to a topic, and a bad topic id all fail', async () => {
  const coverage = {
    covers: { 'settings:about': ['missing'] },
    exempt: { 'settings:gone': 'Was removed.', 'settings:models': 'Has a topic anyway.' },
  };
  await withFixture({ covers: `${allButAbout}, route:gone`, coverage }, async sources => {
    assert.deepEqual((await checkHelpCoverage(sources)).problems, [
      'Topic "a" names "route:gone", which is not a surface any more. Remove it or fix the name.',
      'coverage.json covers maps "settings:about" to "missing", which is not a topic id. Fix the topic id.',
      'coverage.json exempts "settings:gone", which is not a surface any more. Remove the row.',
      '"settings:models" has a topic and an exemption. Remove the exemption from coverage.json.',
      `"settings:about" has no help topic. ${NO_TOPIC_NEXT_STEP}`,
    ]);
  });
});

test('a stuck question must map to a topic', async () => {
  const coverage = {
    exempt: { 'settings:about': 'Shows the version only.' },
    questions: [
      { question: 'Where is my mail?', topic: 'a' },
      { question: 'Why is it slow?', topic: 'nowhere' },
    ],
  };
  await withFixture({ covers: allButAbout, coverage }, async sources => {
    assert.deepEqual((await checkHelpCoverage(sources)).problems, [
      'The stuck question "Why is it slow?" maps to "nowhere", which is not a topic id. Map it to a topic.',
    ]);
  });
});

test('the real coverage file has twelve stuck questions', async () => {
  const { readCoverageFile } = await import('../scripts/check-help-coverage.mjs');
  const { questions } = await readCoverageFile(defaultSources(repoRoot).coveragePath);
  assert.equal(questions.length, 12);
});

test('reads the Settings panels with their labels', () => {
  assert.deepEqual(readSettingsPanels(SETTINGS), [
    { id: 'models', label: 'Models' },
    { id: 'about', label: 'About' },
  ]);
});

test('reads commands from both installer front ends', () => {
  assert.deepEqual([...readInstallerCommands({ cliSource: CLI, shellSource: SHELL })].sort(), [
    'backup',
    'doctor',
    'status',
    'upgrade',
  ]);
});
