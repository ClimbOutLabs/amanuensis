import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accountIsWellFormed,
  addressAllowed,
  allowedAddresses,
  ownNetworks,
  parseAccount,
  publicAccount,
  renderAccount,
} from '../account.mjs';

const ACCOUNT = {
  url: 'https://caldav.example.invalid/dav/',
  username: 'owner@example.invalid',
  password: 'pw-Sentinel_1!',
  email: 'owner@example.invalid',
};

const NO_OWN = ownNetworks({});

describe('the account file', () => {
  it('renders the four settings the installer has always written, and reads them back', () => {
    const text = renderAccount(ACCOUNT);
    assert.deepEqual(
      text
        .split('\n')
        .filter(line => line !== '' && !line.startsWith('#'))
        .map(line => line.split('=')[0]),
      ['CALDAV_URL', 'CALDAV_USERNAME', 'CALDAV_PASSWORD', 'CALDAV_USER_EMAIL'],
    );
    assert.deepEqual(parseAccount(text), ACCOUNT);
  });

  it('reads no account from an empty, partial or unsafe file', () => {
    assert.equal(parseAccount(''), null);
    assert.equal(parseAccount('CALDAV_URL=https://caldav.example.invalid/\n'), null);
    assert.equal(parseAccount(renderAccount(ACCOUNT).replace('https://', 'http://')), null);
  });

  it('never lets a value start a new line or setting', () => {
    for (const bad of [
      { url: 'https://caldav.example.invalid/\nCALDAV_PASSWORD=x' },
      { url: 'https://user:pw@caldav.example.invalid/' },
      { url: 'http://caldav.example.invalid/' },
      { url: 'https://0x7f.1/' },
      { url: 'https://2130706433/dav/' },
      { url: 'https://127.1/' },
      { url: 'https://.../' },
      { url: 'https://caldav.example.invalid/?a=b' },
      { username: 'a b' },
      { username: 'a\nCALDAV_URL=x' },
      { password: "it's" },
      { password: 'two words' },
      { password: 'a\nb' },
      { password: '' },
      { email: 'not-an-address' },
    ]) {
      assert.equal(accountIsWellFormed({ ...ACCOUNT, ...bad }), false, JSON.stringify(bad));
    }
    assert.equal(accountIsWellFormed(ACCOUNT), true);
  });

  it('shows everything but the password', () => {
    const shown = publicAccount(ACCOUNT);
    assert.deepEqual(Object.keys(shown).sort(), ['email', 'url', 'username']);
    assert.ok(!JSON.stringify(shown).includes(ACCOUNT.password));
  });
});

describe('the address rules', () => {
  it('allows public addresses and servers on a home or office network', () => {
    for (const address of ['93.184.216.34', '10.0.0.5', '172.20.1.9', '192.168.1.20', '100.64.3.3', 'fd12:3456::1']) {
      assert.equal(addressAllowed(address, NO_OWN), true, address);
    }
  });

  it('refuses this computer, link-local and cloud metadata addresses, and IPv4 hidden in IPv6', () => {
    for (const address of [
      '0.0.0.0',
      '127.0.0.1',
      '127.1.2.3',
      '169.254.169.254',
      '169.254.170.2',
      '192.0.0.192',
      '100.100.100.200',
      '168.63.129.16',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'fd00:ec2::254',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      'ff02::1',
      'not an address',
    ]) {
      assert.equal(addressAllowed(address, NO_OWN), false, address);
    }
  });

  it("refuses the other members of this container's own network", () => {
    const own = ownNetworks({ eth0: [{ address: '172.18.0.7', family: 'IPv4', cidr: '172.18.0.7/16' }] });
    assert.equal(addressAllowed('172.18.0.2', own), false);
    assert.equal(addressAllowed('172.19.0.2', own), true);
    assert.equal(addressAllowed('192.168.1.20', own), true);
  });

  it('refuses a name when any one of its addresses is refused, and a name that does not resolve', async () => {
    const resolve = async name =>
      name === 'mixed.example.invalid' ? ['93.184.216.34', '127.0.0.1'] : ['93.184.216.34'];
    assert.equal((await allowedAddresses('good.example.invalid', { resolve, ownNetworks: NO_OWN })).ok, true);
    assert.deepEqual(await allowedAddresses('mixed.example.invalid', { resolve, ownNetworks: NO_OWN }), {
      ok: false,
      reason: 'blocked',
    });
    const missing = async () => {
      throw new Error('ENOTFOUND');
    };
    assert.deepEqual(await allowedAddresses('gone.example.invalid', { resolve: missing, ownNetworks: NO_OWN }), {
      ok: false,
      reason: 'unresolved',
    });
    assert.deepEqual(await allowedAddresses('169.254.169.254', { resolve, ownNetworks: NO_OWN }), {
      ok: false,
      reason: 'blocked',
    });
  });
});
