import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSetText, mockStartVoiceRecording } = vi.hoisted(() => ({
  mockSetText: vi.fn(),
  mockStartVoiceRecording: vi.fn(),
}));

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ composer: () => ({ setText: mockSetText }) }),
  useAuiState: (selector: (state: unknown) => unknown) => selector({ composer: { text: 'existing draft' } }),
}));

vi.mock('@/atoms/lib/voiceRecorder.js', () => ({
  isVoiceCaptureSupported: () => true,
  startVoiceRecording: mockStartVoiceRecording,
}));

import type { StartVoiceRecordingOptions } from '@/atoms/lib/voiceRecorder.js';
import { VoiceInputButton } from '@/atoms/VoiceInputButton.js';
import { useSpokenReply } from '@/components/SpokenReplyContext.js';
import {
  VoiceInputProvider,
  type VoiceAvailability,
  type VoiceInputApi,
  type VoiceTranscription,
} from '@/components/VoiceInputContext.js';
import { clearDraftFromVoice, takeDraftFromVoice } from '@/utils/voiceTurn.js';
import { installSpeechSynthesis, removeSpeechSynthesis, stopSpokenReply } from '../utils/speechSynthesisFake.js';

const DEFAULT_TRANSCRIPTION: VoiceTranscription = {
  text: 'hello world',
  language: 'en',
  duration_ms: 5,
  model: 'm',
};

function makeApi({
  availability = true,
  transcribe,
}: {
  availability?: VoiceAvailability;
  transcribe?: (input: { audio: Blob; signal?: AbortSignal }) => Promise<VoiceTranscription>;
} = {}) {
  const listeners = new Set<(available: VoiceAvailability) => void>();
  const transcribeMock = vi.fn(transcribe ?? (async () => DEFAULT_TRANSCRIPTION));
  const api: VoiceInputApi = {
    subscribeAvailability: listener => {
      listeners.add(listener);
      listener(availability);
      return () => {
        listeners.delete(listener);
      };
    },
    transcribe: transcribeMock,
  };
  return {
    api,
    transcribeMock,
    setAvailability: (value: VoiceAvailability) => {
      for (const listener of listeners) {
        listener(value);
      }
    },
  };
}

function makeRecorder() {
  return {
    stop: vi.fn().mockResolvedValue(new Blob(['audio'], { type: 'audio/wav' })),
    cancel: vi.fn(),
  };
}

function hangingTranscribe(capture: { signal?: AbortSignal }) {
  return ({ signal }: { audio: Blob; signal?: AbortSignal }) =>
    new Promise<VoiceTranscription>((_resolve, reject) => {
      capture.signal = signal;
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

beforeEach(() => {
  mockSetText.mockClear();
  mockStartVoiceRecording.mockReset();
  mockStartVoiceRecording.mockImplementation(async () => makeRecorder());
});

describe('VoiceInputButton', () => {
  it('renders nothing when no voice input provider is wired', () => {
    const { container } = render(<VoiceInputButton disabled={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the voice flag has not been read', () => {
    const { api } = makeApi({ availability: null });
    const { container } = render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden when the voice flag is false and appears once it flips true', async () => {
    const { api, setAvailability } = makeApi({ availability: false });
    const { container } = render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );
    expect(container).toBeEmptyDOMElement();

    act(() => {
      setAvailability(true);
    });
    expect(await screen.findByRole('button', { name: 'Record voice message' })).toBeEnabled();
  });

  it('records, shows the transcribing state, and appends the transcript to the draft', async () => {
    let resolveTranscribe!: (value: VoiceTranscription) => void;
    const { api, transcribeMock } = makeApi({
      transcribe: () =>
        new Promise<VoiceTranscription>(resolve => {
          resolveTranscribe = resolve;
        }),
    });
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole('button', { name: 'Stop and transcribe' }));

    // While transcribing, only Cancel is available.
    expect(await screen.findByText('Transcribing…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel transcription' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Record voice message|Stop and transcribe/ })).toBeNull();

    act(() => {
      resolveTranscribe(DEFAULT_TRANSCRIPTION);
    });

    expect(await screen.findByRole('button', { name: 'Record voice message' })).toBeEnabled();
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    const audio = transcribeMock.mock.calls[0]?.[0].audio;
    expect(audio).toBeInstanceOf(Blob);
    expect(mockSetText).toHaveBeenCalledWith('existing draft hello world');
  });

  it('cancel aborts the in-flight transcription and discards the result', async () => {
    const capture: { signal?: AbortSignal } = {};
    const { api, transcribeMock } = makeApi({ transcribe: hangingTranscribe(capture) });
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and transcribe' }));
    await screen.findByText('Transcribing…');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel transcription' }));

    expect(await screen.findByRole('button', { name: 'Record voice message' })).toBeEnabled();
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(capture.signal?.aborted).toBe(true);
    expect(mockSetText).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('unmounting mid-transcription aborts the request and discards the late result', async () => {
    const capture: { signal?: AbortSignal } = {};
    let release!: (reason?: unknown) => void;
    const { api } = makeApi({
      transcribe: ({ signal }) => {
        capture.signal = signal;
        return new Promise<VoiceTranscription>((resolve, reject) => {
          release = (reason?: unknown) =>
            reason === 'resolve' ? resolve(DEFAULT_TRANSCRIPTION) : reject(signal?.reason);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const { unmount } = render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and transcribe' }));
    await screen.findByText('Transcribing…');

    unmount();
    expect(capture.signal?.aborted).toBe(true);

    // A late resolve after unmount must not touch the composer.
    release('resolve');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockSetText).not.toHaveBeenCalled();
  });

  it('backgrounding the tab releases the mic and ends the session', async () => {
    const recorder = makeRecorder();
    mockStartVoiceRecording.mockResolvedValueOnce(recorder);
    const { api } = makeApi();
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));
    await screen.findByRole('button', { name: 'Stop and transcribe' });

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }

    expect(recorder.cancel).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Record voice message' })).toBeEnabled();
  });

  it('shows an inline dismissible error when transcription fails', async () => {
    const { api, transcribeMock } = makeApi({
      transcribe: () => Promise.reject(new Error('stt down')),
    });
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and transcribe' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Transcription failed, try again or type instead');
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Record voice message' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss transcription error' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the limit notice after an auto-stopped segment transcribes', async () => {
    let autoStop: (() => void) | undefined;
    let resolveTranscribe!: (value: VoiceTranscription) => void;
    mockStartVoiceRecording.mockImplementation((options: StartVoiceRecordingOptions) => {
      autoStop = options.onAutoStop;
      return Promise.resolve(makeRecorder());
    });
    const { api } = makeApi({
      transcribe: () =>
        new Promise<VoiceTranscription>(resolve => {
          resolveTranscribe = resolve;
        }),
    });
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));
    await screen.findByRole('button', { name: 'Stop and transcribe' });

    act(() => {
      autoStop?.();
    });
    expect(await screen.findByText('Transcribing…')).toBeInTheDocument();

    act(() => {
      resolveTranscribe(DEFAULT_TRANSCRIPTION);
    });
    const notice = await screen.findByText(
      'Recording stopped at the 3-minute limit. Tap the mic to record another segment.',
    );
    expect(notice).toBeInTheDocument();
    expect(mockSetText).toHaveBeenCalledWith('existing draft hello world');
  });

  it('enters the tappable denied state on permission denial and recovers with Try again', async () => {
    mockStartVoiceRecording.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
    const { api } = makeApi();
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));

    // Denied is tappable, not disabled.
    const denied = await screen.findByRole('button', { name: 'Microphone access denied. Tap for help.' });
    expect(denied).toBeEnabled();

    fireEvent.click(denied);
    const dialog = await screen.findByRole('dialog', { name: 'Microphone access denied' });
    expect(dialog).toHaveTextContent('Enable it in your browser settings to use voice input, or type instead.');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Stop and transcribe' })).toBeEnabled();
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a mic error when capture fails for a non-permission reason', async () => {
    mockStartVoiceRecording.mockRejectedValueOnce(new Error('no device'));
    const { api, transcribeMock } = makeApi();
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone unavailable');
    expect(transcribeMock).not.toHaveBeenCalled();
  });
});

describe('VoiceInputButton and read-aloud replies', () => {
  beforeEach(() => {
    clearDraftFromVoice();
  });

  afterEach(() => {
    stopSpokenReply();
    removeSpeechSynthesis();
  });

  it('starting to record stops any reply that is being read aloud', async () => {
    const synthesis = installSpeechSynthesis();
    void renderHook(() => useSpokenReply()).result.current.speak('A long reply.', { key: 'msg-1' });
    const { api } = makeApi();
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );
    const cancelsBefore = synthesis.cancel.mock.calls.length;

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));

    expect(synthesis.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
  });

  it('marks the draft as spoken once a transcript is added to it', async () => {
    installSpeechSynthesis();
    const { api } = makeApi();
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and transcribe' }));
    await screen.findByRole('button', { name: 'Record voice message' });

    expect(takeDraftFromVoice()).toBe(true);
  });
});
