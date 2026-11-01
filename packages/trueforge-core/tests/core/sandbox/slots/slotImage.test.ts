import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SLOT_AGENT_VERSION, SLOT_PLATFORM, SLOT_RUNSC_VERSION } from '../../../../src/core/sandbox/slots/slotContract';
import {
  DEFAULT_OCR_LANGUAGES,
  requiredOcrLanguages,
  tesseractPackageFor,
} from '../../../../src/documents/ocrLanguages';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');

function read(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

function captured(text: string, pattern: RegExp): string {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) {
    throw new Error(`${String(pattern)} not found`);
  }
  return value;
}

describe('the slot image and the server agree on what is deployed', () => {
  test('the gVisor release in the Dockerfile is the one the server expects', () => {
    const release = captured(read('ops/sandbox-slot/Dockerfile'), /^ARG RUNSC_RELEASE=(\S+)$/m);
    expect(SLOT_RUNSC_VERSION).toBe(`runsc version release-${release}`);
  });

  test('the guest image has the tools and language data the document pipeline needs', () => {
    const dockerfile = read('ops/sandbox-slot/Dockerfile');
    const block = captured(
      dockerfile,
      /(apt-get install -y --no-install-recommends poppler-utils[\s\S]*?)&& apt-get clean/,
    );
    const installed = block.replace(/\\\n/g, ' ').split(/\s+/);
    // pdfinfo, pdftotext and pdftoppm come from poppler-utils; poppler-data maps CJK character codes to text.
    expect(installed).toEqual(expect.arrayContaining(['poppler-utils', 'poppler-data', 'tesseract-ocr']));
    // Every language the server may select, and script detection, has its data package in the image.
    for (const language of requiredOcrLanguages(DEFAULT_OCR_LANGUAGES)) {
      expect(installed).toContain(tesseractPackageFor(language));
    }
  });

  test('the guest image has the test runners and linters a coding session needs', () => {
    const dockerfile = read('ops/sandbox-slot/Dockerfile');
    const requirementsIn = read('ops/sandbox-slot/guest/requirements.in');
    const requirements = read('ops/sandbox-slot/guest/requirements.txt');
    const guestPackage = read('ops/sandbox-slot/guest/package.json');
    const guestLock = read('ops/sandbox-slot/guest/package-lock.json');

    // Python tools are named in requirements.in and pinned, with hashes, in the compiled lock.
    for (const tool of ['pytest', 'ruff', 'mypy']) {
      expect(requirementsIn).toMatch(new RegExp(`^${tool}$`, 'm'));
      expect(requirements).toMatch(new RegExp(`^${tool}==\\d+\\.\\d+\\.\\d+ `, 'm'));
    }

    // Node tools are pinned to one exact version in package.json, and the lock resolves that same version.
    for (const tool of ['vitest', 'jest', 'eslint', 'prettier']) {
      const pinned = captured(guestPackage, new RegExp(`"${tool}": "(\\d+\\.\\d+\\.\\d+)"`));
      const locked = captured(guestLock, new RegExp(`"node_modules/${tool}": \\{\\s*"version": "([^"]+)"`));
      expect(locked).toBe(pinned);
      // Each one sits on the guest PATH through /usr/local/bin, the same way tsc and tsx do.
      expect(dockerfile).toContain(`ln -s /opt/sandbox-tools/node_modules/.bin/${tool} /usr/local/bin/${tool}`);
    }

    // The build runs every tool once, so a broken install fails the build instead of a later session.
    for (const tool of ['pytest', 'ruff', 'mypy', 'vitest', 'jest', 'eslint', 'prettier']) {
      expect(dockerfile).toContain(`${tool} --version`);
    }
  });

  test('the agent reports the build and platform the server expects', () => {
    const main = read('ops/sandbox-slot/agent/cmd/aman-slot-agent/main.go');
    expect(captured(main, /agentVersion\s*=\s*"([^"]+)"/)).toBe(SLOT_AGENT_VERSION);
    expect(captured(main, /Platform:\s*"([^"]+)"/)).toBe(SLOT_PLATFORM);
  });

  test('the cgroup limits the agent pins are the ones the compose file sets', () => {
    const attest = read('ops/sandbox-slot/agent/src/attest/attest.go');
    expect(captured(attest, /ExpectedMemoryBytes\s*=\s*(\d+) << 30/)).toBe('2');
    const pids = Number(captured(attest, /ExpectedPidsLimit\s*=\s*(\d+)/));
    const compose = read('docker-compose.slots.yml');
    expect(captured(compose, /^ {2}mem_limit: (\S+)$/m)).toBe('2g');
    expect(Number(captured(compose, /^ {2}pids_limit: (\d+)$/m))).toBe(pids);
  });
});
