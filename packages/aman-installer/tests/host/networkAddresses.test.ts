import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'node:os';
import { test } from 'node:test';

import { networkAddressList, networkInstallAddresses } from '../../src/host/networkAddresses.ts';

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:11:22:33:44:55',
    internal,
    cidr: `${address}/24`,
  };
}

function v6(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:11:22:33:44:55',
    internal,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

test('the list keeps the private addresses of the real adapters, in order, and the host name', () => {
  const list = networkAddressList({
    interfaces: {
      Ethernet: [v4('192.168.1.20')],
      'Ethernet 2': [v4('10.0.0.5')],
      'Wi-Fi': [v4('172.16.4.9'), v6('fd00::9')],
    },
    hostName: 'DESKTOP-ABC',
  });
  assert.deepEqual(list.ipv4, ['192.168.1.20', '10.0.0.5', '172.16.4.9']);
  assert.deepEqual(list.ipv6, ['fd00::9']);
  assert.equal(list.hostName, 'desktop-abc');
});

test('the virtual adapters are skipped even when their addresses are private', () => {
  const list = networkAddressList({
    interfaces: {
      'vEthernet (Default Switch)': [v4('172.29.0.1')],
      'vEthernet (WSL)': [v4('172.21.0.1')],
      'VMware Network Adapter VMnet8': [v4('192.168.206.1')],
      'VirtualBox Host-Only Network': [v4('192.168.56.1')],
      'Hyper-V Virtual Ethernet Adapter': [v4('192.168.10.1')],
      Ethernet: [v4('192.168.1.20')],
    },
    hostName: 'desktop-abc',
  });
  assert.deepEqual(list.ipv4, ['192.168.1.20']);
});

test('Tailscale is kept, and its range counts as private only on the Tailscale adapter', () => {
  const list = networkAddressList({
    interfaces: {
      Tailscale: [v4('100.101.102.103'), v6('fd7a:115c:a1e0::abcd')],
      Ethernet: [v4('100.64.10.5'), v4('192.168.1.20')],
    },
    hostName: 'desktop-abc',
  });
  assert.deepEqual(list.ipv4, ['100.101.102.103', '192.168.1.20']);
  assert.deepEqual(list.ipv6, ['fd7a:115c:a1e0::abcd']);
});

test('public, link-local and loopback addresses are never in the list', () => {
  const list = networkAddressList({
    interfaces: {
      Ethernet: [v4('203.0.113.7'), v4('169.254.9.9'), v4('8.8.8.8'), v6('2601:646:8a00:1234::5'), v6('fe80::1')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true), v6('::1', true)],
      'Wi-Fi': [v4('192.168.0.2'), v6('fd12:3456::1')],
    },
    hostName: 'desktop-abc',
  });
  assert.deepEqual(list.ipv4, ['192.168.0.2']);
  assert.deepEqual(list.ipv6, ['fd12:3456::1']);
});

test('an address that shows up twice is listed once, and an adapter with no facts is passed over', () => {
  const list = networkAddressList({
    interfaces: {
      Ethernet: [v4('192.168.1.20'), v4('192.168.1.20')],
      'Wi-Fi': [v4('192.168.1.20')],
      'Unknown adapter': undefined,
    },
    hostName: 'desktop-abc',
  });
  assert.deepEqual(list.ipv4, ['192.168.1.20']);
});

test('the host name is the short name in lowercase, or nothing when it is not a usable name', () => {
  const nameOf = (hostName: string) => networkAddressList({ interfaces: {}, hostName }).hostName;
  assert.equal(nameOf('DESKTOP-ABC'), 'desktop-abc');
  assert.equal(nameOf('host.corp.example'), 'host');
  assert.equal(nameOf('a'), 'a');
  assert.equal(nameOf('pc123'), 'pc123');
  assert.equal(nameOf('1234567'), null);
  assert.equal(nameOf('1234567.corp.example'), null);
  assert.equal(nameOf('My Computer!'), null);
  assert.equal(nameOf('bad_name'), null);
  assert.equal(nameOf(''), null);
});

test('the installer is handed the IPv4 addresses and the name, never the IPv6 addresses', () => {
  const list = networkAddressList({
    interfaces: {
      Ethernet: [v4('192.168.1.20'), v6('fd00::9')],
    },
    hostName: 'DESKTOP-ABC',
  });
  assert.deepEqual(networkInstallAddresses(list), ['192.168.1.20', 'desktop-abc']);
  assert.deepEqual(networkInstallAddresses({ ipv4: ['10.0.0.5'], ipv6: [], hostName: null }), ['10.0.0.5']);
  assert.deepEqual(networkInstallAddresses({ ipv4: [], ipv6: [], hostName: null }), []);
});

test('the Tailscale-range addresses stay in the list but are not handed to the installer', () => {
  const list = networkAddressList({
    interfaces: {
      Tailscale: [v4('100.101.102.103')],
      Ethernet: [v4('192.168.1.20')],
    },
    hostName: 'DESKTOP-ABC',
  });
  assert.deepEqual(list.ipv4, ['100.101.102.103', '192.168.1.20']);
  assert.deepEqual(networkInstallAddresses(list), ['192.168.1.20', 'desktop-abc']);
});

test('a Tailscale-only computer hands the installer its name and no Tailscale-range address', () => {
  const list = networkAddressList({
    interfaces: {
      Tailscale: [v4('100.101.102.103')],
    },
    hostName: 'DESKTOP-ABC',
  });
  assert.deepEqual(list.ipv4, ['100.101.102.103']);
  assert.deepEqual(networkInstallAddresses(list), ['desktop-abc']);
});
