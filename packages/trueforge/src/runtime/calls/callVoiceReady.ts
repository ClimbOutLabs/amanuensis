import type { TtsHealth } from '../../voice/ttsClient';

/** Said where calls are offered while the parts that listen and speak are not running. */
export const CALLS_NEED_VOICE = 'Calls need the voice parts of Aman. Start them, then try again in a minute.';
/** Said when the voice service is running but too old to check what it says. */
export const CALLS_VOICE_OUT_OF_DATE = 'The voice service is out of date. Run aman upgrade, then try again.';

/** Whether a call can talk, and when it cannot, the one reason to tell the person. */
export type CallVoice = 'ready' | 'not_running' | 'out_of_date';

/** The words for a call that cannot talk yet. */
export function callVoiceProblem(voice: Exclude<CallVoice, 'ready'>): string {
  return voice === 'out_of_date' ? CALLS_VOICE_OUT_OF_DATE : CALLS_NEED_VOICE;
}

/**
 * Whether a call can talk: it needs to hear the person, speak to them and find its listening model. A phone that rings
 * while any of these is missing would be silent or deaf, so the call is not made and the text and push go instead.
 */
export async function callVoiceReady({
  sttReady,
  tts,
  vadModel,
}: {
  sttReady: () => boolean;
  tts: () => Promise<TtsHealth>;
  vadModel: () => Promise<unknown>;
}): Promise<CallVoice> {
  if (!sttReady()) {
    return 'not_running';
  }
  const [speaks, model] = await Promise.all([
    tts(),
    vadModel().then(
      () => true,
      () => false,
    ),
  ]);
  if (speaks === 'down' || !model) {
    return 'not_running';
  }
  return speaks === 'ready' ? 'ready' : 'out_of_date';
}

/** Whether calls can work, kept in one place so Reach me, Noticing and placing a call all give the same answer. */
interface CallReadiness {
  /** The last check's answer; not running until the first check. */
  current: () => CallVoice;
  /** Checks now and keeps the answer. Callers that ask while a check runs share it. */
  check: () => Promise<CallVoice>;
}

/**
 * The speech-to-text part of a check is that service's own watcher cache (up to 30 seconds old), so only the voice
 * that speaks and the listening model are looked at afresh each time.
 */
export function createCallReadiness(probe: () => Promise<CallVoice>): CallReadiness {
  let voice: CallVoice = 'not_running';
  let running: Promise<CallVoice> | undefined;
  return {
    current: () => voice,
    check() {
      running ??= probe()
        .catch((): CallVoice => 'not_running')
        .then(answer => {
          voice = answer;
          running = undefined;
          return answer;
        });
      return running;
    },
  };
}
