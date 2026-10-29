import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installerConfig } from '../src/config.ts';

test('the state home defaults to .amanuensis in the home folder', () => {
  assert.equal(installerConfig({ env: {}, homeDir: '/home/person' }).stateHome, '/home/person/.amanuensis');
});

test('AMANUENSIS_HOME names the state home when it is set', () => {
  assert.equal(
    installerConfig({ env: { AMANUENSIS_HOME: '/data/aman' }, homeDir: '/home/person' }).stateHome,
    '/data/aman',
  );
});

test('an empty AMANUENSIS_HOME is treated as not set', () => {
  assert.equal(
    installerConfig({ env: { AMANUENSIS_HOME: '' }, homeDir: '/home/person' }).stateHome,
    '/home/person/.amanuensis',
  );
});

test('the doctor inputs default to the shell doctor paths', () => {
  const config = installerConfig({ env: {}, homeDir: '/home/person' });
  assert.equal(config.homeDir, '/home/person');
  assert.equal(config.osReleasePath, '/etc/os-release');
  assert.equal(config.dockerConfigDir, '/home/person/.docker');
  assert.equal(config.appService, 'app');
});

test('the doctor inputs follow their environment settings', () => {
  const config = installerConfig({
    env: { DOCKER_CONFIG: '/data/docker', AMAN_OS_RELEASE: '/data/os-release', AMAN_DOCTOR_APP_SERVICE: 'web' },
    homeDir: '/home/person',
  });
  assert.equal(config.osReleasePath, '/data/os-release');
  assert.equal(config.dockerConfigDir, '/data/docker');
  assert.equal(config.appService, 'web');
});

test('the windows folder root is the AppData Local folder Windows would name', () => {
  const config = installerConfig({ env: {}, homeDir: '/home/person' });
  assert.equal(config.localAppDataDir, '/home/person/AppData/Local');
});

test('the windows folder root follows LOCALAPPDATA when Windows names it', () => {
  const config = installerConfig({
    env: { LOCALAPPDATA: 'C:\\Users\\Friend\\AppData\\Local' },
    homeDir: 'C:\\Users\\Friend',
  });
  assert.equal(config.localAppDataDir, 'C:\\Users\\Friend\\AppData\\Local');
});
