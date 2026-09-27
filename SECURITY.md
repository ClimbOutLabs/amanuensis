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

## Supported versions

Only the latest `main` is supported. There are no maintained older release branches.

## Upstream harness

Amanuensis is a fork of [TrueForge](https://github.com/truefoundry/trueforge). A vulnerability in the upstream harness itself (not specific to changes made in this fork) should also be reported to TrueFoundry under their own policy: [github.com/truefoundry/trueforge/security/policy](https://github.com/truefoundry/trueforge/security/policy). This fork tracks and pulls in upstream security fixes; see [docs/deployment-security.mdx](docs/deployment-security.mdx) for the deployment security posture.
