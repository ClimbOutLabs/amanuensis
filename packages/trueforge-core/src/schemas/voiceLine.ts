/**
 * The text messages on the voice line, shared by the server that sends them and the page that reads
 * them. Audio goes as binary frames and is not described here.
 */
import { z } from 'zod';

/** What the voice WebSocket sends to the browser as text frames. */
export const VoiceServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), sample_rate: z.number().int().positive() }),
  z.object({ type: z.literal('clear') }),
  z.object({ type: z.literal('state'), state: z.enum(['listening', 'thinking', 'speaking']) }),
  z.object({ type: z.literal('heard'), text: z.string() }),
  z.object({ type: z.literal('turn_saved'), turn_id: z.string() }),
  z.object({ type: z.literal('notice'), text: z.string() }),
]);
export type VoiceServerEvent = z.infer<typeof VoiceServerEventSchema>;
export type VoiceLineState = Extract<VoiceServerEvent, { type: 'state' }>['state'];

/** What the browser sends as text frames. */
export const VoiceClientMessageSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('end') })]);
export type VoiceClientMessage = z.infer<typeof VoiceClientMessageSchema>;
