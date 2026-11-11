# Security Policy

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.

Instead, report them privately through GitHub private vulnerability reporting on this repository:

- [github.com/ClimbOutLabs/amanuensis/security/advisories/new](https://github.com/ClimbOutLabs/amanuensis/security/advisories/new)

Please include as much of the following as you can:

- A description of the vulnerability and its impact
- Steps to reproduce, or a proof of concept
- Affected versions or deployment modes (standalone / multi-replica / Helm)
- Any suggested mitigations

## What to expect

Amanuensis is maintained by a single maintainer. Response times are best effort, not covered by a service-level agreement.

- Acknowledgement within 7 days of the report.
- Updates as the investigation and fix progress.
- Credit in the release notes when the fix ships, unless you prefer to remain anonymous.

## Checking a download

The Windows download, Aman-Setup.exe, is not signed with a Windows publisher certificate. Every release instead carries `manifest.json`, which lists each file with its SHA-256 hash, and `manifest.json.minisig`, its signature made with the Aman release key. The release key is:

```
RWR8aR0vofffsH8dRDfeCxHcPAo2hBKQp6W9krptCFjneeXPDr+ZB0wr
```

To check a file, put it in one folder with `manifest.json` and `manifest.json.minisig`, then:

1. Check the signature with [minisign](https://github.com/jedisct1/minisign): `minisign -Vm manifest.json -P <the key above>`. It must say the signature is verified.
2. Work out the file's hash (`Get-FileHash` in Windows PowerShell, `shasum -a 256` on a Mac, `sha256sum` on Linux) and find the same hash next to its name in `manifest.json`.

If you already have Aman, `aman verify <file>` does both steps with the same key built into it. Each release page repeats these steps.

## Supported versions

Only the latest `main` is supported. There are no maintained older release branches.

## Upstream harness

Amanuensis is a fork of [TrueForge](https://github.com/truefoundry/trueforge). A vulnerability in the upstream harness itself (not specific to changes made in this fork) should also be reported to TrueFoundry under their own policy: [github.com/truefoundry/trueforge/security/policy](https://github.com/truefoundry/trueforge/security/policy). This fork tracks and pulls in upstream security fixes; see [docs/deployment-security.mdx](docs/deployment-security.mdx) for the deployment security posture.
