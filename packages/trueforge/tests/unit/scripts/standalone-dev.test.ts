import { readFileSync } from 'node:fs';
import path from 'node:path';

interface PackageScripts {
  scripts: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Reads a package.json's scripts table with runtime validation instead of a
// cast, so a malformed manifest fails the test loudly rather than silently.
function readPackageScripts(...segments: string[]): PackageScripts {
  const file = path.resolve(__dirname, ...segments);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`expected ${file} to hold a JSON object`);
  }
  const scripts = parsed['scripts'];
  if (!isRecord(scripts)) {
    throw new Error(`expected ${file} to define a scripts table`);
  }
  const table: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error(`expected script "${name}" in ${file} to be a non-empty string`);
    }
    table[name] = command;
  }
  return { scripts: table };
}

function getScript(pkg: PackageScripts, name: string): string {
  const command = pkg.scripts[name];
  if (command === undefined) {
    throw new Error(`expected script "${name}" to exist`);
  }
  return command;
}

// Follows `pnpm run <name>` delegation one package deep so the routing
// assertion below judges the command that actually executes.
function resolveScript(pkg: PackageScripts, name: string, seen: string[] = []): string {
  if (seen.includes(name)) {
    throw new Error(`circular script reference: ${[...seen, name].join(' -> ')}`);
  }
  const command = getScript(pkg, name).trim();
  const delegation = /^pnpm run ([A-Za-z0-9:_-]+)$/.exec(command);
  if (delegation) {
    const target = delegation[1];
    if (target === undefined) {
      throw new Error(`could not parse delegation target in script "${name}"`);
    }
    return resolveScript(pkg, target, [...seen, name]);
  }
  return command;
}

const rootPkg = readPackageScripts('..', '..', '..', '..', '..', 'package.json');
const serverPkg = readPackageScripts('..', '..', '..', 'package.json');
const frontendPkg = readPackageScripts('..', '..', '..', '..', '..', 'packages', 'frontend', 'package.json');

describe('standalone:dev startup routing', () => {
  it('routes the documented one-command startup through the no-watch variants', () => {
    // `tsx watch` 4.23.x can park silently during pre-spawn init on Windows —
    // no banner, no child process, backend never listens on :8790 — while the
    // UI on :3000 reports proxy ECONNREFUSED. The quickstart must not depend
    // on it, even indirectly through script delegation.
    const command = resolveScript(rootPkg, 'standalone:dev');
    expect(command).toContain('no-watch');
    expect(command).not.toContain('tsx watch');
  });

  it('keeps a standalone no-watch entrypoint that starts the API and UI', () => {
    const command = getScript(rootPkg, 'standalone:dev:no-watch');
    expect(command).toContain('STANDALONE=true');
    expect(command).toContain('--filter @truefoundry/trueforge');
    expect(command).toContain('--filter frontend');
    expect(command).toContain('dev:no-watch');
    expect(command).not.toContain('tsx watch');
  });

  it('provides server no-watch scripts that run plain tsx', () => {
    for (const name of ['dev:no-watch', 'predev:no-watch', 'dev:serve:no-watch', 'dev:controller:no-watch']) {
      expect(getScript(serverPkg, name)).not.toContain('tsx watch');
    }
    // The no-watch serve/controller variants must still launch the processes;
    // plain `tsx` (no `watch` subcommand) is the supported launcher.
    expect(getScript(serverPkg, 'dev:serve:no-watch')).toContain('tsx ');
    expect(getScript(serverPkg, 'dev:controller:no-watch')).toContain('tsx ');
  });

  it('wires the server dev:no-watch through the no-watch serve and controller', () => {
    const command = getScript(serverPkg, 'dev:no-watch');
    expect(command).toContain('dev:serve:no-watch');
    expect(command).toContain('dev:controller:no-watch');
    expect(command).not.toContain('tsx watch');
  });

  it('keeps frontend hot reload available via dev:no-watch', () => {
    expect(getScript(frontendPkg, 'dev:no-watch')).toBeDefined();
  });
});
