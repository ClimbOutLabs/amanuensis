import { VoiceClientMessageSchema, VoiceLineStateSchema, VoiceServerEventSchema } from '../../src/schemas/voiceLine';

describe('the voice line messages', () => {
  it.each([
    { type: 'ready', sample_rate: 24000 },
    { type: 'clear' },
    { type: 'state', state: 'speaking' },
    { type: 'heard', text: 'hello' },
    { type: 'turn_saved', turn_id: 't1' },
    { type: 'notice', text: 'Voice mode ended.' },
    { type: 'tts_failed' },
  ])('accepts the server message %j', message => {
    expect(VoiceServerEventSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    { type: 'state', state: 'sleeping' },
    { type: 'ready', sample_rate: 0 },
    { type: 'turn_saved' },
    { type: 'unknown' },
  ])('refuses the server message %j', message => {
    expect(VoiceServerEventSchema.safeParse(message).success).toBe(false);
  });

  it('names the states a line can be in, and the state message uses the same list', () => {
    expect(VoiceLineStateSchema.options).toEqual(['listening', 'thinking', 'speaking']);
    for (const state of VoiceLineStateSchema.options) {
      expect(VoiceServerEventSchema.safeParse({ type: 'state', state }).success).toBe(true);
    }
  });

  it('accepts only the end message from the browser', () => {
    expect(VoiceClientMessageSchema.safeParse({ type: 'end' }).success).toBe(true);
    expect(VoiceClientMessageSchema.safeParse({ type: 'start' }).success).toBe(false);
  });
});
