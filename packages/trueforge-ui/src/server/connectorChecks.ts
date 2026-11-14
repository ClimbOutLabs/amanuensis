/** The connector connection checks the Harness adds on top of the runtime's connector port. */
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/**
 * Why a connection test failed. `auth_required` and `unreachable` stay apart because the fix
 * differs: one is the credential, the other is the endpoint. `error` is anything the tools route
 * did not classify, reported as it arrived rather than guessed at.
 */
export type ConnectorConnectionFailureKind = 'auth_required' | 'unreachable' | 'error';

/**
 * Outcome of a connector connection test: one live MCP `tools/list` over the same url and headers
 * a turn resolves, so a connector that answers here is one a turn can use.
 */
export type ConnectorConnectionTest =
  { ok: true; toolNames: string[] } | { ok: false; kind: ConnectorConnectionFailureKind; message: string };

/** The connection test, as the Harness connector catalog exposes it. */
export interface ConnectorChecks {
  /** Dials a saved connector's MCP endpoint once and reports what it answered, changing nothing. */
  testConnector(req: { id: string }): Promise<ConnectorConnectionTest>;
}

/**
 * Whether a catalog implements the connection test. The runtime's connector port does not declare
 * it and another host's catalog may not carry it, so a settings surface reads for it and hides the
 * control when it is absent.
 */
export function hasConnectorConnectionTest(catalog: object): catalog is Pick<ConnectorChecks, 'testConnector'> {
  return typeof Reflect.get(catalog, 'testConnector') === 'function';
}

/**
 * Outcome of the Home Assistant connection check: the handshake and tool list, plus how many
 * exposed entities the live-context tool named. A failure carries the one thing to fix. The
 * generated SDK owns this shape now that its client carries the check route, so the UI derives
 * its type from there instead of restating the wire contract by hand.
 */
export type HomeAssistantCheck = TrueForgeApi.HomeAssistantCheckResult;

/** The Home Assistant check the Harness adds on top of the runtime's connector port. */
export interface HomeAssistantCheckPort {
  /** Dials the saved Home Assistant connector once and reports what it answered, changing nothing. */
  checkHomeAssistant(req: { id: string }): Promise<HomeAssistantCheck>;
}

/** Whether a catalog implements the Home Assistant check. */
export function hasHomeAssistantCheck(catalog: object): catalog is HomeAssistantCheckPort {
  return typeof Reflect.get(catalog, 'checkHomeAssistant') === 'function';
}
