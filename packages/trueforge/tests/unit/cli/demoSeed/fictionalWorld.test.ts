import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildDemoWorld } from '../../../../src/cli/demoSeed/world';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

/*
 * The real businesses, numbers and prices the demo story was drawn from. They are built from parts so this
 * file does not contain them: the check is that they appear nowhere in the repository, this file included.
 */
const REAL_NAMES = [
  ['Med', 'Visit'],
  ['MAE', ' ', 'Clinic'],
  ['X', '-', 'Clinic'],
  ['Taberna da Rua', ' das Flores'],
  ['Caf', 'é Tati'],
  ['Lisboa', ' Foto'],
  ['Marta C', '. Monteiro'],
].map(parts => parts.join(''));
const REAL_PRICE = ['€', '85'].join('');
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.md',
  '.mdx',
  '.json',
  '.mjs',
  '.cjs',
  '.js',
  '.sh',
  '.yml',
  '.yaml',
  '.txt',
]);

function trackedAndNewFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .toString('utf8')
    .split('\0')
    .filter(file => file !== '' && SCANNED_EXTENSIONS.has(path.extname(file)) && !file.endsWith('pnpm-lock.yaml'));
}

function worldJson(): string {
  return JSON.stringify(
    buildDemoWorld({ today: { year: 2026, month: 10, day: 26 }, timeZone: 'Europe/Lisbon', modelName: 'demo/model' }),
  );
}

describe('the demo world is fictional', () => {
  it('names the clinics with invented names, and no real business name is left anywhere in the repository', () => {
    const world = worldJson();
    for (const name of ['Brightwater Family Clinic', 'Linden Court Medical', 'Amoreira Health Check']) {
      expect(world).toContain(name);
    }

    const offenders = trackedAndNewFiles().flatMap(file => {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8').toLowerCase();
      return [...REAL_NAMES, REAL_PRICE]
        .filter(real => text.includes(real.toLowerCase()))
        .map(real => `${file}: ${real.length} chars`);
    });
    expect(offenders).toEqual([]);
  });

  it('gives the clinics no price', () => {
    expect(worldJson()).not.toContain(REAL_PRICE);
  });

  it('holds no email address, so nothing can reach a real mailbox', () => {
    const addresses = worldJson().match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];

    expect(addresses).toEqual([]);
  });
});
