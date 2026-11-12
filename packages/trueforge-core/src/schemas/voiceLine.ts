/**
 * The text messages on the voice line, shared by the server that sends them and the page that reads
 * them. Audio goes as binary frames and is not described here.
 */
import { z } from 'zod';

export const VoiceLineStateSchema = z.enum(['listening', 'thinking', 'speaking']);
export type VoiceLineState = z.infer<typeof VoiceLineStateSchema>;

/** What the voice WebSocket sends to the browser as text frames. */
export const VoiceServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), sample_rate: z.number().int().positive() }),
  z.object({ type: z.literal('clear') }),
  z.object({ type: z.literal('state'), state: VoiceLineStateSchema }),
  z.object({ type: z.literal('heard'), text: z.string() }),
  z.object({ type: z.literal('turn_saved'), turn_id: z.string() }),
  z.object({ type: z.literal('notice'), text: z.string() }),
  /** A reply could not be turned into sound, so the line went quiet. The reply is still in the chat. */
  z.object({ type: z.literal('tts_failed') }),
]);
export type VoiceServerEvent = z.infer<typeof VoiceServerEventSchema>;

/** What the browser sends as text frames. */
export const VoiceClientMessageSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('end') })]);
export type VoiceClientMessage = z.infer<typeof VoiceClientMessageSchema>;
