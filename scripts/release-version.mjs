/**
 * Root `pnpm release:version <x.y.z>` entry.
 *
 * Raises the user-facing display version, which lives in one constant
 * (packages/trueforge-core/src/core/displayVersion.ts) and nowhere else:
 * validates the target, rewrites the constant, opens a dated CHANGELOG entry,
 * and prints the git tag command for the maintainer to run. It never touches
 * package.json versions, publishes, tags, or pushes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DISPLAY_VERSION_PATH = 'packages/trueforge-core/src/core/displayVersion.ts';
export const CHANGELOG_PATH = 'CHANGELOG.md';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** Parses a strict semver string, or returns null when it is not valid semver. */
export function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) {
    return null;
  }
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? null : prerelease.split('.'),
  };
}

function comparePrerelease(left, right) {
  if (left === null && right === null) {
    return 0;
  }
  // A release outranks the same version with a prerelease suffix.
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (Number(leftPart) !== Number(rightPart)) {
        return Number(leftPart) < Number(rightPart) ? -1 : 1;
      }
    } else if (leftNumeric) {
      return -1;
    } else if (rightNumeric) {
      return 1;
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

/** Semver precedence: negative when `left` is lower, positive when higher, 0 when equal. */
export function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Reads the current display version out of the displayVersion module source. */
export function readDisplayVersion(source) {
  const match = /export const APP_DISPLAY_VERSION = '([^']+)'/.exec(source);
  if (match === null) {
    throw new Error(`${DISPLAY_VERSION_PATH} does not define APP_DISPLAY_VERSION`);
  }
  return match[1];
}

/** Returns the displayVersion module source with the constant set to `next`. */
export function replaceDisplayVersion(source, next) {
  if (!/export const APP_DISPLAY_VERSION = '[^']+'/.test(source)) {
    throw new Error(`${DISPLAY_VERSION_PATH} does not define APP_DISPLAY_VERSION`);
  }
  return source.replace(/export const APP_DISPLAY_VERSION = '[^']+'/, `export const APP_DISPLAY_VERSION = '${next}'`);
}

/** Returns the changelog source with a dated heading for `version` above the newest entry. */
export function insertChangelogHeading(source, version, date) {
  const heading = `## ${version} - ${date}`;
  const lines = source.split('\n');
  const firstEntry = lines.findIndex(line => line.startsWith('## '));
  if (firstEntry === -1) {
    return `${source.trimEnd()}\n\n${heading}\n`;
  }
  lines.splice(firstEntry, 0, heading, '');
  return lines.join('\n');
}

/**
 * Validates the raise and applies it under `rootDir`. Returns what changed plus
 * the tag command for the maintainer; throws without writing anything when the
 * target is not a valid semver strictly higher than the current version.
 */
export function runRelease({ rootDir, nextVersion, today }) {
  const versionFile = join(rootDir, DISPLAY_VERSION_PATH);
  const changelogFile = join(rootDir, CHANGELOG_PATH);
  const versionSource = readFileSync(versionFile, 'utf8');
  const current = readDisplayVersion(versionSource);

  const next = parseSemver(nextVersion);
  if (next === null) {
    throw new Error(`"${nextVersion}" is not a valid semver version (expected x.y.z)`);
  }
  const parsedCurrent = parseSemver(current);
  if (parsedCurrent === null) {
    throw new Error(`Current display version "${current}" in ${DISPLAY_VERSION_PATH} is not valid semver`);
  }
  if (compareSemver(next, parsedCurrent) <= 0) {
    throw new Error(`"${nextVersion}" is not higher than the current display version ${current}`);
  }

  const changelogSource = readFileSync(changelogFile, 'utf8');
  writeFileSync(versionFile, replaceDisplayVersion(versionSource, nextVersion));
  writeFileSync(changelogFile, insertChangelogHeading(changelogSource, nextVersion, today));
  return { current, next: nextVersion, tagCommand: `git tag v${nextVersion}` };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: pnpm release:version <x.y.z>');
    process.exit(1);
  }
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const today = new Date().toISOString().slice(0, 10);
  try {
    const result = runRelease({ rootDir, nextVersion: args[0], today });
    console.log(`Display version ${result.current} -> ${result.next}`);
    console.log(`Updated ${DISPLAY_VERSION_PATH} and ${CHANGELOG_PATH}.`);
    console.log('Review the diff, commit, then tag the release:');
    console.log(result.tagCommand);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
