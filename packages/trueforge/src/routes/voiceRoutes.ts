/**
 * Voice input route definitions.
 * Mounted at /api/v1/voice; handlers are registered in apis/voice.ts.
 *
 * The browser posts recorded audio to `POST /transcribe`; the handler forwards
 * the bytes to the `aman-stt` sidecar and returns the transcript. `GET /status`
 * lets the composer hide voice input when the sidecar is unreachable.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { RequestErrorResponseSchema } from '../schemas/errors';
import { VoiceStatusResponseSchema, VoiceTranscriptionResponseSchema } from '../schemas/voice';
import { OpenApiTag } from './openapiTags';

export const transcribeVoiceRoute = createRoute({
  method: 'post',
  path: '/transcribe',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Transcribe a voice recording',
  description:
    'Accepts 16 kHz mono 16-bit PCM WAV audio and returns the transcript produced by the local STT sidecar. Audio bodies over 30 MB are rejected.',
  'x-fern-sdk-group-name': ['voice'],
  'x-fern-sdk-method-name': 'transcribe',
  request: {
    body: {
      content: {
        'audio/wav': {
          // Binary request: the handler reads the raw audio bytes itself.
          schema: z.string().openapi({ type: 'string', format: 'binary' }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: VoiceTranscriptionResponseSchema } },
      description: 'Transcript produced by the local STT sidecar.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Malformed audio.',
    },
    413: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Audio body over the 30 MB limit.',
    },
    503: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'STT sidecar unreachable or not warm.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'STT sidecar returned an unexpected response.',
    },
  },
});

export const getVoiceStatusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Check voice input availability',
  description: 'Probes the local STT sidecar; the chat composer hides voice input when it is unavailable.',
  'x-fern-sdk-group-name': ['voice'],
  'x-fern-sdk-method-name': 'get_status',
  responses: {
    200: {
      content: { 'application/json': { schema: VoiceStatusResponseSchema } },
      description: 'STT availability.',
    },
  },
});
