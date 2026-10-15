import type { DoctorDeps, HttpResponse } from '../deps';
import { describeNetworkError, redactUrl } from '../redact';
import { failCheck, okCheck, type Check } from '../schemas';

export type LoginProbe =
  | { kind: 'unconfigured' }
  | { kind: 'invalid_issuer' }
  | { kind: 'unreachable'; reason: string; issuer: string }
  | { kind: 'answered'; issuer: string; response: HttpResponse };

/** One request to the login provider's discovery document. */
export async function probeLogin({ deps, timeoutMs }: { deps: DoctorDeps; timeoutMs: number }): Promise<LoginProbe> {
  const raw = deps.env['OIDC_ISSUER_URL']?.trim();
  if (!raw) {
    return { kind: 'unconfigured' };
  }
  let discovery: string;
  try {
    discovery = `${new URL(raw).href.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  } catch {
    return { kind: 'invalid_issuer' };
  }
  const issuer = redactUrl(raw);
  try {
    return { kind: 'answered', issuer, response: await deps.get({ url: discovery, timeoutMs }) };
  } catch (error) {
    return { kind: 'unreachable', reason: describeNetworkError(error), issuer };
  }
}

function hasIssuer(json: unknown): boolean {
  return typeof json === 'object' && json !== null && 'issuer' in json && typeof json.issuer === 'string';
}

export function checkLogin(probe: LoginProbe): Check {
  const id = 'login';
  switch (probe.kind) {
    case 'unconfigured':
      return failCheck({
        id,
        detail: 'No login provider is configured for this instance.',
        fix: 'Rerun install.sh to regenerate the login settings; the app refuses to run without login.',
      });
    case 'invalid_issuer':
      return failCheck({
        id,
        detail: 'The login address (OIDC_ISSUER_URL) is not a valid web address.',
        fix: 'Set OIDC_ISSUER_URL in the instance .env file to the full address of your login provider, then restart the instance.',
      });
    case 'unreachable':
      return failCheck({
        id,
        detail: `The login provider at ${probe.issuer} did not answer (${probe.reason}).`,
        fix: 'Check that the login container (Dex) is running with "docker ps". If you set a public address, make sure its reverse proxy forwards the login address and that this machine can resolve the name.',
      });
    case 'answered':
      if (probe.response.status !== 200 || !hasIssuer(probe.response.json)) {
        return failCheck({
          id,
          detail: `The login provider at ${probe.issuer} answered, but not with a login discovery document (status ${String(probe.response.status)}).`,
          fix: 'Check that OIDC_ISSUER_URL points at the login provider itself and not at the app, and that any reverse proxy passes the path through unchanged.',
        });
      }
      return okCheck({ id, detail: `The login provider at ${probe.issuer} answers.` });
  }
}
