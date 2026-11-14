# Spec: Connectors and models on your own computer

**Status:** implemented

## Problem

Aman checks every address it connects to for a connector or a model. The check refused any address on the computer Aman runs on. That was right for addresses a remote server hands Aman, such as a redirect or a sign-in address, because a remote server must never steer Aman inward. But it also refused addresses the owner typed in Settings. On a direct install, a connector at `http://localhost:27123` or a model at `http://localhost:11434/v1` was refused unless the operator listed it in a setting, and the refusal told the person to fix it in Settings, which they could not do.

## Solution

Who chose the address decides how strict the check is.

- **An address the owner chose** (a connector or model saved in Settings, or set by the operator) may be on the computer Aman runs on, when Aman runs directly on it. That includes `localhost`, the computer's own home network or Tailscale address, and `.local` or `*.ts.net` names that point at it. No setting is needed.
- **An address a remote server chose** (a model redirect, a sign-in discovery, registration or token address, and their redirects) keeps the strict rule: nothing on the computer Aman runs on.
- **Protected addresses are always refused:** link-local, cloud metadata addresses and the other special ranges.
- **In a container install,** `localhost` and the container's own addresses are Aman itself, and the container networks hold Aman's own parts, so those stay refused for everyone. A service on the owner's computer is reached at `host.docker.internal`, which the check allows.
- **A demo instance** is used by visitors, not its owner, so it judges every address the strict way.

`LOCAL_MODEL_ENDPOINTS` and `FIRST_PARTY_MCP_ORIGINS` keep working as the operator's way to allow one exact endpoint the rules refuse.

## Design decisions

- The check returns why an address is refused: `protected` or `internal` (inside Aman itself). Each refusal message says the one thing to do next. An internal refusal points at `host.docker.internal`.
- Trust is unchanged. A memory provider on an unlisted origin can now be saved, but it is not first-party, so its tools still ask before they run.

## Privacy

No personal data is involved. The change only decides which network addresses Aman may connect to. Nothing new leaves the device.

## Testing

Unit tests with synthetic addresses and a fake name resolver cover both rules, direct and container installs, demo instances, protected addresses and IPv4-mapped IPv6 addresses. API tests cover saving and using connectors and models, and the memory provider trust rules. No real user data or screenshots are used.

## Out of scope

- Sign-in for a connector on the owner's own computer on a direct install. Its sign-in addresses are chosen by the connector's server, so they keep the strict rule.
