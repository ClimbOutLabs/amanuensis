import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runVerify } from '../../src/commands/verify.ts';
import {
  VERIFY_MANIFEST_MISSING,
  VERIFY_SIGNATURE_MISSING,
  VERIFY_USAGE,
  problemText,
  verifyChangedProblem,
  verifyOkLine,
} from '../../src/messages.ts';
import { buildManifest, manifestToBytes, type SourceIds } from '../../src/release/manifest.ts';
import { signMinisign } from '../../src/release/minisign.ts';
import { TEST_PUBLIC_KEY_MINISIGN, testKeyNum, testPrivateKeyDer } from './testKeys.ts';

const IDS: SourceIds = {
  'aman-app': 'aman-app:0123456789ab',
  'aman-stt': 'aman-stt:0123456789cd',
  'aman-calendar-caldav': 'aman-calendar-caldav:0123456789ef',
};

const ASSET_NAME = 'aman-linux-x64';
const ASSET_DATA = new TextEncoder().encode('the linux build');

function releaseFolder({ signWithTestKey }: { signWithTestKey: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'aman-installer-verify-'));
  writeFileSync(join(dir, ASSET_NAME), ASSET_DATA);
  const manifest = buildManifest({
    release: 'v1.2.3',
    files: [{ name: ASSET_NAME, data: ASSET_DATA }],
    sourceIds: IDS,
  });
  const bytes = manifestToBytes(manifest);
  writeFileSync(join(dir, 'manifest.json'), bytes);
  if (signWithTestKey) {
    writeFileSync(
      join(dir, 'manifest.json.minisig'),
      signMinisign({ data: bytes, privateKeyDer: testPrivateKeyDer(), keyNum: testKeyNum() }),
    );
  }
  return dir;
}

async function runVerifyOn(file: string | undefined): Promise<{ exitCode: number; printed: string[] }> {
  const printed: string[] = [];
  const exitCode = await runVerify(
    {
      print: (line: string) => {
        printed.push(line);
      },
      // The test key stands in for the compiled-in release key, so a
      // record signed with it checks out in these tests.
      releasePublicKey: TEST_PUBLIC_KEY_MINISIGN,
    },
    { file },
  );
  return { exitCode, printed };
}

test('aman verify passes a download that matches the signed record', async () => {
  const dir = releaseFolder({ signWithTestKey: true });
  const { exitCode, printed } = await runVerifyOn(join(dir, ASSET_NAME));
  assert.equal(exitCode, 0);
  assert.deepEqual(printed, [verifyOkLine(ASSET_NAME)]);
});

test('aman verify refuses a download that changed after signing', async () => {
  const dir = releaseFolder({ signWithTestKey: true });
  writeFileSync(join(dir, ASSET_NAME), new TextEncoder().encode('a different build'));
  const { exitCode, printed } = await runVerifyOn(join(dir, ASSET_NAME));
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(verifyChangedProblem(ASSET_NAME))]);
});

test('aman verify refuses when the record or its signature is missing', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'aman-installer-verify-bare-'));
  writeFileSync(join(bare, ASSET_NAME), ASSET_DATA);
  const noManifest = await runVerifyOn(join(bare, ASSET_NAME));
  assert.equal(noManifest.exitCode, 1);
  assert.deepEqual(noManifest.printed, [problemText(VERIFY_MANIFEST_MISSING)]);

  const unsigned = releaseFolder({ signWithTestKey: false });
  const noSignature = await runVerifyOn(join(unsigned, ASSET_NAME));
  assert.equal(noSignature.exitCode, 1);
  assert.deepEqual(noSignature.printed, [problemText(VERIFY_SIGNATURE_MISSING)]);
});

test('aman verify with no file named says what it needs', async () => {
  const { exitCode, printed } = await runVerifyOn(undefined);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(VERIFY_USAGE)]);
});

test('the verify output matches the golden file', async () => {
  const dir = releaseFolder({ signWithTestKey: true });
  const okRun = await runVerifyOn(join(dir, ASSET_NAME));
  writeFileSync(join(dir, ASSET_NAME), new TextEncoder().encode('a different build'));
  const changedRun = await runVerifyOn(join(dir, ASSET_NAME));
  const golden = readFileSync(new URL('../golden/verify.txt', import.meta.url), 'utf8');
  assert.equal(`${[...okRun.printed, ...changedRun.printed].join('\n')}\n`, golden);
});
