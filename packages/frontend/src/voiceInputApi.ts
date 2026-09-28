import type { VoiceAvailability, VoiceInputApi, VoiceTranscription } from '@truefoundry/trueforge-ui';

import { apiPath } from './publicPath';

/** Re-fetch cadence while the `voice` capability flag has not been observed true. */
const CAPABILITIES_POLL_INTERVAL_MS = 5000;
/** Poll attempts before dropping to focus/route-change-only refetches (~1 minute). */
const CAPABILITIES_POLL_ATTEMPTS = 12;
/** Client-side transcription timeout; just above the backend's 60s forward timeout. */
const TRANSCRIBE_TIMEOUT_MS = 65_000;
/** Window event dispatched when SPA navigation happens (pushState/replaceState/popstate/hashchange). */
const ROUTE_CHANGE_EVENT = 'trueforge:routechange';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the `voice` capability flag defensively; absent or malformed reads false. */
function readVoiceFlag(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  const data: unknown = 'data' in body ? body.data : body;
  return isRecord(data) && data.voice === true;
}

/**
 * Installs a one-time SPA route-change dispatcher: React Router navigations go
 * through `history.pushState`/`replaceState`, which fire no event on their own.
 */
let routeDispatchInstalled = false;

function installRouteChangeDispatch(): void {
  if (routeDispatchInstalled || typeof window === 'undefined') {
    return;
  }
  routeDispatchInstalled = true;
  const dispatch = () => window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);
  window.history.pushState = function (data: unknown, unused: string, url?: string | URL | null): void {
    originalPushState(data, unused, url);
    dispatch();
  };
  window.history.replaceState = function (data: unknown, unused: string, url?: string | URL | null): void {
    originalReplaceState(data, unused, url);
    dispatch();
  };
  window.addEventListener('popstate', dispatch);
  window.addEventListener('hashchange', dispatch);
}

async function readError(response: Response): Promise<Error> {
  try {
    const body: unknown = await response.json();
    const detail = isRecord(body) ? body.error : undefined;
    // v2 503 shape is `{ "error": "voice input unavailable" }`; other failures
    // use the `{ error: { message } }` envelope.
    if (typeof detail === 'string' && detail !== '') {
      return new Error(detail);
    }
    if (isRecord(detail) && typeof detail.message === 'string') {
      return new Error(detail.message);
    }
  } catch (error) {
    return new Error(`The voice request failed with status ${String(response.status)}.`, { cause: error });
  }
  return new Error(`The voice request failed with status ${String(response.status)}.`);
}

/** Accepts the `{ data: transcription }` envelope or the bare transcription object. */
function parseTranscription(value: unknown): VoiceTranscription {
  const candidate: unknown = isRecord(value) && 'data' in value ? value.data : value;
  if (
    !isRecord(candidate) ||
    typeof candidate.text !== 'string' ||
    typeof candidate.language !== 'string' ||
    typeof candidate.duration_ms !== 'number' ||
    typeof candidate.model !== 'string'
  ) {
    throw new Error('The transcription response was invalid.');
  }
  return {
    text: candidate.text,
    language: candidate.language,
    duration_ms: candidate.duration_ms,
    model: candidate.model,
  };
}

/**
 * Host implementation of the trueforge-ui voice input port, backed by the agent
 * backend. Availability comes from the `voice` capability flag in
 * `/api/v1/capabilities`: polled every 5s for ~1 minute, then on focus/route
 * change only, until the flag reads true. Once observed true the flag latches
 * and later refetches never hide the mic within the session.
 */
export type CreateVoiceInputApiOptions = {
  /** Override the 5s capabilities poll cadence. */
  pollIntervalMs?: number;
  /** Override the ~1-minute poll attempt budget. */
  pollAttempts?: number;
  /** Override the 65s client-side transcription timeout. */
  transcribeTimeoutMs?: number;
};

export function createVoiceInputApi(fetcher: typeof fetch, options: CreateVoiceInputApiOptions = {}): VoiceInputApi {
  const pollIntervalMs = options.pollIntervalMs ?? CAPABILITIES_POLL_INTERVAL_MS;
  const pollAttempts = options.pollAttempts ?? CAPABILITIES_POLL_ATTEMPTS;
  const transcribeTimeoutMs = options.transcribeTimeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  let availability: VoiceAvailability = null;
  let latched = false;
  let started = false;
  let attempts = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(available: VoiceAvailability) => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener(availability);
    }
  };

  const stopPolling = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const check = async (): Promise<void> => {
    if (latched || inFlight) {
      return;
    }
    inFlight = true;
    try {
      let flag = false;
      try {
        const response = await fetcher(apiPath('/api/v1/capabilities'));
        if (response.ok) {
          flag = readVoiceFlag(await response.json());
        }
      } catch {
        flag = false;
      }
      if (latched) {
        return;
      }
      if (flag) {
        latched = true;
        availability = true;
        stopPolling();
        notify();
        return;
      }
      availability = false;
      attempts += 1;
      notify();
      if (attempts < pollAttempts && timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          void check();
        }, pollIntervalMs);
      }
    } finally {
      inFlight = false;
    }
  };

  const onDemandCheck = () => {
    if (!latched && timer === undefined) {
      void check();
    }
  };

  const ensureStarted = () => {
    if (started) {
      return;
    }
    started = true;
    if (typeof window !== 'undefined') {
      installRouteChangeDispatch();
      window.addEventListener(ROUTE_CHANGE_EVENT, onDemandCheck);
      window.addEventListener('focus', onDemandCheck);
    }
    void check();
  };

  return {
    subscribeAvailability(listener: (available: VoiceAvailability) => void): () => void {
      listeners.add(listener);
      ensureStarted();
      listener(availability);
      return () => {
        listeners.delete(listener);
      };
    },

    async transcribe({ audio, signal }: { audio: Blob; signal?: AbortSignal }): Promise<VoiceTranscription> {
      // The caller's signal (cancel, unmount, route change) plus the 65s
      // client-side timeout drive one controller for the fetch.
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal?.reason);
      if (signal !== undefined) {
        if (signal.aborted) {
          controller.abort(signal.reason);
        } else {
          signal.addEventListener('abort', forwardAbort, { once: true });
        }
      }
      const timeout = setTimeout(() => {
        controller.abort(
          new DOMException(
            `Transcription timed out after ${String(Math.round(transcribeTimeoutMs / 1000))} seconds`,
            'TimeoutError',
          ),
        );
      }, transcribeTimeoutMs);
      try {
        // v1 passes no language hint; the backend auto-detects.
        const response = await fetcher(apiPath('/api/v1/voice/transcribe'), {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: audio,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw await readError(response);
        }
        return parseTranscription(await response.json());
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', forwardAbort);
      }
    },
  };
}
