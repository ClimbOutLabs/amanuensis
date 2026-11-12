import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SETUP_ASSET_NAME,
  buildAssetNames,
  isSetupProgramName,
  windowsAssetName,
} from '../../src/release/assetNames.ts';

test('the windows asset name follows the release naming', () => {
  assert.equal(windowsAssetName('x64'), 'aman-windows-x64.exe');
  assert.equal(windowsAssetName('arm64'), 'aman-windows-arm64.exe');
});

test('the windows build is published under its system name and as Aman-Setup.exe', () => {
  assert.equal(SETUP_ASSET_NAME, 'Aman-Setup.exe');
  assert.deepEqual(buildAssetNames({ platform: 'win32', arch: 'x64' }), ['aman-windows-x64.exe', 'Aman-Setup.exe']);
  assert.deepEqual(buildAssetNames({ platform: 'darwin', arch: 'arm64' }), ['aman-darwin-arm64']);
  assert.deepEqual(buildAssetNames({ platform: 'linux', arch: 'x64' }), ['aman-linux-x64']);
  assert.equal(buildAssetNames({ platform: 'freebsd', arch: 'x64' }), null);
});

test('the setup download still runs the setup when the browser renamed it', () => {
  for (const name of ['Aman-Setup.exe', 'aman-setup.exe', 'Aman-Setup', 'Aman-Setup (1).exe', 'Aman-Setup(2).exe']) {
    assert.equal(isSetupProgramName(name), true, name);
  }
  for (const name of ['aman.exe', 'aman-windows-x64.exe', 'Aman-Setup.exe.part', 'Aman-Setup (x).exe']) {
    assert.equal(isSetupProgramName(name), false, name);
  }
});
