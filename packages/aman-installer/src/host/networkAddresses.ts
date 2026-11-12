import type { NetworkInterfaceInfo } from 'node:os';

// This computer's addresses on its private networks, read on the host:
// the setup container cannot see the computer's adapters, so the list
// is made here and handed to install.sh. The keep and skip rules mirror
// the shell's own (private_ipv4 and the address list in network.sh):
// private addresses of real adapters only, never a public address,
// never every address, and the 100.64.0.0/10 range only where it is
// Tailscale's own address on this computer.

// Adapter names that are not real adapters a device could reach this
// computer through: the switches and host-only networks of the virtual
// machine tools, and the WSL adapters. Tailscale is the one virtual
// adapter that is kept, by its own name, checked before this list.
const SKIPPED_ADAPTER_WORDS: readonly string[] = ['vethernet', 'hyper-v', 'virtualbox', 'vmware', 'wsl'];

export interface NetworkAddressList {
  ipv4: readonly string[];
  ipv6: readonly string[];
  hostName: string | null;
}

function ipv4Parts(address: string): readonly number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const value = Number.parseInt(part, 10);
    if (value > 255) {
      return null;
    }
    numbers.push(value);
  }
  return numbers;
}

// Tailscale's own range, 100.64.0.0/10, over already-read parts.
function tailscaleRangeParts(parts: readonly number[]): boolean {
  const [a, b] = parts;
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

// True when an address sits in Tailscale's own range, 100.64.0.0/10:
// private on this computer, where the Tailscale adapter is, and
// public-looking to any judge that has no Tailscale adapter of its
// own, install.sh's address check inside the setup container included.
export function tailscaleRangeIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  return parts !== null && tailscaleRangeParts(parts);
}

// The private ranges, as the shell's private_ipv4 reads them: RFC 1918,
// plus Tailscale's own range on the Tailscale adapter only. Link-local
// and loopback are not addresses other devices use, and the address
// list the shell keeps skips them too.
function privateIpv4(address: string, onTailscale: boolean): boolean {
  const parts = ipv4Parts(address);
  if (parts === null) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) {
    return true;
  }
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (tailscaleRangeParts(parts)) {
    return onTailscale;
  }
  return false;
}

// The private IPv6 range: the unique local addresses, fc00::/7, which
// is also the range Tailscale's own IPv6 addresses sit in. Link-local
// addresses name an adapter as well as an address, so no device could
// open one from the list, and they are left out.
function privateIpv6(address: string): boolean {
  const bare = (address.split('%')[0] ?? '').toLowerCase();
  const firstGroup = bare.split(':')[0] ?? '';
  if (!/^[0-9a-f]{1,4}$/.test(firstGroup)) {
    return false;
  }
  const group = Number.parseInt(firstGroup, 16);
  return (group & 0xfe00) === 0xfc00;
}

// The computer's short name, lowercase, when it is a name the shell's
// own rule would take: a single label of letters, digits and hyphens,
// and not digits alone, which the shell refuses as a number rather
// than a name.
function shortHostName(rawName: string): string | null {
  const firstLabel = rawName.trim().toLowerCase().split('.')[0] ?? '';
  if (/^\d+$/.test(firstLabel)) {
    return null;
  }
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(firstLabel) ? firstLabel : null;
}

export function networkAddressList(options: {
  interfaces: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>;
  hostName: string;
}): NetworkAddressList {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const [name, infos] of Object.entries(options.interfaces)) {
    if (infos === undefined) {
      continue;
    }
    const lowerName = name.toLowerCase();
    const onTailscale = lowerName.includes('tailscale');
    if (!onTailscale && SKIPPED_ADAPTER_WORDS.some(word => lowerName.includes(word))) {
      continue;
    }
    for (const info of infos) {
      if (info.internal) {
        continue;
      }
      if (info.family === 'IPv4') {
        if (privateIpv4(info.address, onTailscale) && !ipv4.includes(info.address)) {
          ipv4.push(info.address);
        }
      } else {
        const bare = (info.address.split('%')[0] ?? '').toLowerCase();
        if (privateIpv6(info.address) && !ipv6.includes(bare)) {
          ipv6.push(bare);
        }
      }
    }
  }
  return { ipv4, ipv6, hostName: shortHostName(options.hostName) };
}

// The addresses install.sh is handed, one --address at a time: the IPv4
// addresses and the computer's name, minus two parts of the list. The
// Tailscale-range addresses stay in the list but are not handed over:
// install.sh judges each address where it runs, inside the setup
// container, whose adapters have no Tailscale, so it refuses that
// range as public. And the IPv6 addresses are not handed over either:
// the list above is the whole picture of this computer's private
// addresses, and install.sh's address check takes IPv4 addresses and
// names only today.
export function networkInstallAddresses(list: NetworkAddressList): readonly string[] {
  const handed = list.ipv4.filter(address => !tailscaleRangeIpv4(address));
  return list.hostName === null ? handed : [...handed, list.hostName];
}
