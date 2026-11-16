# Spec: Private Network Addresses

**Status:** approved

## Problem

Aman on Linux and Windows listened on this computer and its private network addresses, but it also found and listened on Tailscale addresses by itself, with special rules for Tailscale names and Tailscale serve ports. Other VPNs (NetBird, ZeroTier, WireGuard) got none of this, so Aman behaved differently depending on which VPN a person used. When the computer's home network address changed, Aman could fail to start at all, even on this computer, and a browser at an address Aman did not know got a bare error with no way forward.

## Solution

- By default Aman listens on this computer (127.0.0.1) and on each private home network address of this computer: 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16. Never on a public address, and never on a VPN link by itself.
- `aman address add <address>` adds anything else, the same way for every VPN or proxy:
  - an address of this computer, such as a VPN address: Aman listens there too;
  - a name: Aman answers to it and puts it on its https certificate;
  - a full address such as `https://aman.example.ts.net`: a forward. Another program (Tailscale serve, a web server) passes visitors on to Aman at 127.0.0.1, and sign-in accepts that address. Nothing new listens.
  - `aman address list` and `aman address remove <address>` show and undo these. Public addresses, and plain http to a public name, are refused.
- A browser that opens Aman at an address it was not set up for gets a page that names that address and shows the exact `aman address add` command, with a Copy button. `aman doctor` lists the addresses refused in the last week.
- The home network ports are published by their own small container. When the computer loses an address, only that container stops; Aman keeps working on this computer.
- Every `aman` command prints one line when this computer no longer has an address Aman listens on, with the command that fixes it: `aman doctor network --fix`.
- The docs recommend reserving the computer's address in the router.

## Design Decisions

**No VPN special cases.** Aman does not ask the Tailscale command, look for Tailscale names, or work around Tailscale serve ports. Every VPN and proxy goes through `aman address add`, so all of them work the same way.

**No carry-over on upgrade.** An install that relied on a Tailscale address stops answering there after the upgrade. The refusal page tells the owner the one command that brings it back.

**No watcher.** Aman does not install a background job, change firewall rules, or listen on every address and filter. A changed address is reported by the next `aman` command and fixed by the owner.

**Real client address kept.** The home network container passes each connection to Aman's https server with the PROXY protocol, so sign-in rate limits still see which device connected.

**Outbound unchanged.** Which addresses Aman may connect out to (local models, Home Assistant, a NAS on Tailscale) is not changed.

## Privacy

No new data leaves the device. The refused-address list holds only the last ten host names a browser used, with the time, in the instance's own data folder, and is read only by `aman doctor`.

## Testing

Installer shell tests with stubbed network tools and synthetic documentation addresses cover the default listening addresses, the separate container, `aman address` add, list, remove and refusals, forwards on a local-only instance, and the changed-address line. App unit tests cover the refusal page, its escaping and the refused-address log. All tests use synthetic data.

## Out of Scope

- An `aman address` command in the Windows setup program.
- IPv6 addresses.
- An in-app notice when other devices cannot reach Aman.
