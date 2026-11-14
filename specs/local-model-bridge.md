# Spec: Reach a model on this computer through a local model bridge

**Status:** draft

## Problem

People run a model server on the same computer as Aman (Ollama, a vLLM or llama.cpp server) and give Aman one of that computer's own addresses: its LAN address, its Tailscale address or its Tailscale name. The app's containers reach that address over a Docker bridge. That path is fragile:

- A model server that listens only on `127.0.0.1` never answers there.
- A network change on the computer can stop the address from accepting connections from containers while it still works for programs on the computer itself. Tailscale 1.104 on Linux did this: Tailscale Serve listeners began refusing connections that arrive through a Docker bridge.

When the connection was refused, the chat said the model's reply broke off. No reply had started.

## Solution

A model on this computer keeps working at the addresses it always did: `host.docker.internal`, or the computer's LAN or Tailscale address or name. Settings saves them as before. The bridge is an optional extra for the two cases above.

1. **A local model bridge.** `aman local-model PORT` names a port of this computer that the instance should carry. Two small services join the instance:
   - `local-model-host` runs on the computer's side (host network on native Linux Docker, `host.docker.internal` under Docker Desktop) and connects to `127.0.0.1:PORT`.
   - `local-model-link` sits on an internal network that only the app joins, under the name `aman-local-model`, and listens on each named port.
   - The two sides meet through socket files in a volume of their own. Nothing is published on any of the computer's addresses. Only the ports the owner named are carried.
   - The model's address in Settings becomes `http://aman-local-model:PORT/v1`. A loopback-only model works.
2. **A bridge port that was never added.** Saving `http://aman-local-model:PORT/v1` while that port is not carried is refused, with the `aman local-model PORT` command to run.
3. **Honest failure wording.** A model call whose connection never started (refused, unreachable, name not found, closed before any answer) is reported as "could not connect, so no reply was started", never as a reply that broke off. It is retried once with the same history, since a short network blip can cause it, and never compacts the chat. The words depend on the address:
   - the bridge: nothing answered at that port, so start the model server
   - any other address: check that the model server is running and can be reached

## Design decisions

- **Root cause, not a setting.** Aman does not change, suggest or document any operating system or Tailscale setting. The bridge avoids the fragile path instead.
- **Optional, never required.** No model address that worked before is refused. The app is not told this computer's addresses, so it never decides a model is on this computer.
- **No address check is loosened.** `aman-local-model` is a container on a private Docker network, which the model address checks already allow.
- **Only named ports.** The bridge carries what the owner named with `aman local-model`, nothing else, and only the app can reach it.
- **Windows (Aman Setup) is not covered yet.** The installer runs in a container there, so the command says to use `host.docker.internal`.
- **An older app image is detected** before any change, and the command says to run `aman upgrade`.

## Privacy

Model traffic through the bridge stays on the computer. No new outside host is contacted.

## Testing

All tests use synthetic data.

- `tests/local-model-bridge.test.mjs`: a loopback-only model answers through the bridge, a stopped model gives a closed connection with no answer, and the host side listens on its socket file only.
- `installer/tests/lib/local-model.test.sh`: compose output for host network and Docker Desktop, the internal network, the alias, no published ports, adding and removing ports, bad ports and an older image.
- `packages/trueforge/tests/unit/apis/modelProviders.test.ts`: a model saved by this computer's Tailscale name, Tailscale address, LAN address, a name that resolves to it, or `host.docker.internal` is saved. A bridge address whose port is not listed is refused with the command to run, and saved once it is listed.
- `packages/trueforge/tests/unit/runtime/sessionResources.test.ts`: the same own addresses resolve for use.
- `packages/trueforge-core/tests/core/llm`: a real refused connection and a relay that closes early give the new words, with one call and no compaction. A reply that broke off after it began is still a stream fault.

## Out of scope

- MCP servers on the same computer (a follow-up can carry them through the same bridge).
- A one-click "use the local link" button in Settings.
- Windows Aman Setup support.
