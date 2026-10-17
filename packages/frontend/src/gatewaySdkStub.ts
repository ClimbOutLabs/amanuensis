/**
 * Build-time replacement for `truefoundry-gateway-sdk/agents*`, an optional peer
 * of `@truefoundry/assistant-ui-runtime` whose main entry imports it statically.
 * Aliasing keeps the unlicensed SDK out of the bundle; Aman never calls it.
 */
function gatewaySdkMissing(): never {
  throw new Error('truefoundry-gateway-sdk is not bundled in this app');
}

export const AgentSessionClient = gatewaySdkMissing;
export const PrivateAgentSessionClient = gatewaySdkMissing;
