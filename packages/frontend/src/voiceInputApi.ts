import type { VoiceInputApi, VoiceStatus, VoiceTranscription } from '@truefoundry/trueforge-ui';

import { apiPath } from './publicPath';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readError(response: Response): Promise<Error> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
      return new Error(body.error.message);
    }
  } catch (error) {
    return new Error(`The voice request failed with status ${String(response.status)}.`, { cause: error });
  }
  return new Error(`The voice request failed with status ${String(response.status)}.`);
}

function parseStatus(value: unknown): VoiceStatus {
  if (!isRecord(value) || typeof value.stt_available !== 'boolean' || typeof value.model !== 'string') {
    throw new Error('The voice status response was invalid.');
  }
  return { stt_available: value.stt_available, model: value.model };
}

function parseTranscription(value: unknown): VoiceTranscription {
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    typeof value.language !== 'string' ||
    typeof value.duration_ms !== 'number' ||
    typeof value.model !== 'string'
  ) {
    throw new Error('The transcription response was invalid.');
  }
  return { text: value.text, language: value.language, duration_ms: value.duration_ms, model: value.model };
}

/** Host implementation of the trueforge-ui voice input port, backed by the agent backend. */
export function createVoiceInputApi(fetcher: typeof fetch): VoiceInputApi {
  return {
    async getStatus(): Promise<VoiceStatus> {
      let response: Response;
      try {
        response = await fetcher(apiPath('/api/v1/voice/status'));
      } catch {
        return { stt_available: false, model: '' };
      }
      if (!response.ok) {
        return { stt_available: false, model: '' };
      }
      try {
        const body: unknown = await response.json();
        if (!isRecord(body) || !('data' in body)) {
          return { stt_available: false, model: '' };
        }
        return parseStatus(body.data);
      } catch {
        return { stt_available: false, model: '' };
      }
    },

    async transcribe({ audio, language }: { audio: Blob; language?: string }): Promise<VoiceTranscription> {
      const params = language !== undefined ? `?language=${encodeURIComponent(language)}` : '';
      const response = await fetcher(apiPath(`/api/v1/voice/transcribe${params}`), {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: audio,
      });
      if (!response.ok) {
        throw await readError(response);
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !('data' in body)) {
        throw new Error('The transcription response was invalid.');
      }
      return parseTranscription(body.data);
    },
  };
}
