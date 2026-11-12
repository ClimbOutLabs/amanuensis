import configuration from '../config';

/** The header the speech sidecars check on every call except their health check. */
export const SPEECH_SECRET_HEADER = 'x-speech-secret';

/** The shared-secret header for a call to a speech sidecar; empty when no secret is set, and the sidecar then refuses. */
export function speechSecretHeaders(): Record<string, string> {
  const secret = configuration.SPEECH_SECRET;
  return secret === undefined ? {} : { [SPEECH_SECRET_HEADER]: secret };
}
