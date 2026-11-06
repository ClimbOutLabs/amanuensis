/**
 * Whether a call can talk: it needs to hear the person, speak to them and find its listening model. A phone that rings
 * while any of these is missing would be silent or deaf, so the call is not made and the text and push go instead.
 */
export async function callVoiceReady({
  sttReady,
  ttsReady,
  vadModel,
}: {
  sttReady: () => boolean;
  ttsReady: () => Promise<boolean>;
  vadModel: () => Promise<unknown>;
}): Promise<boolean> {
  if (!sttReady()) {
    return false;
  }
  const [speaks, model] = await Promise.all([
    ttsReady(),
    vadModel().then(
      () => true,
      () => false,
    ),
  ]);
  return speaks && model;
}

/** Whether calls can work, kept in one place so Reach me, Noticing and placing a call all give the same answer. */
export interface CallReadiness {
  /** The last check's answer; false until the first check. */
  current: () => boolean;
  /** Checks now and keeps the answer. Callers that ask while a check runs share it. */
  check: () => Promise<boolean>;
}

export function createCallReadiness(probe: () => Promise<boolean>): CallReadiness {
  let ready = false;
  let running: Promise<boolean> | undefined;
  return {
    current: () => ready,
    check() {
      running ??= probe()
        .catch(() => false)
        .then(answer => {
          ready = answer;
          running = undefined;
          return answer;
        });
      return running;
    },
  };
}
