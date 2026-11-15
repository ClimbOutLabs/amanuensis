import { speechLimiter, speechPersonKey } from '../../voice/speechRateLimit';
import { SidecarSpeechSynthesizer } from '../../voice/ttsClient';

/**
 * How a call speaks: with the default voice, since the voice a person picked is kept in their browser, and in the
 * person's own place at the voice service, shared with voice mode and read-aloud so a call waits its turn.
 */
export function callSpeaking(owner: { tenant_id: string; created_by: string }): SidecarSpeechSynthesizer {
  return new SidecarSpeechSynthesizer({
    share: {
      limiter: speechLimiter,
      person: speechPersonKey({ tenantId: owner.tenant_id, personId: owner.created_by }),
    },
  });
}
