import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SLOT_AGENT_VERSION, SLOT_PLATFORM, SLOT_RUNSC_VERSION } from '../../../../src/core/sandbox/slots/slotContract';

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

  test('the guest image has the tools the document pipeline runs inside the sandbox', () => {
    const dockerfile = read('ops/sandbox-slot/Dockerfile');
    const installed = captured(dockerfile, /apt-get install -y --no-install-recommends (poppler-utils[^\\\n]*)/);
    // pdfinfo, pdftotext and pdftoppm come from poppler-utils; OCR needs tesseract and its English data.
    expect(installed.split(/\s+/)).toEqual(
      expect.arrayContaining(['poppler-utils', 'tesseract-ocr', 'tesseract-ocr-eng']),
    );
    const sandbox = read('packages/trueforge-core/src/core/sandbox/Sandbox.ts');
    for (const tool of ['pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract']) {
      expect(sandbox).toContain(tool);
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
