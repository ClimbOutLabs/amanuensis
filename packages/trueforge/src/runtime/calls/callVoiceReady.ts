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
