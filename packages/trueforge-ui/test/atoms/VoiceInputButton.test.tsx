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
import { HANDS_FREE_MAX_MS, HOLD_TO_SEND_MS, VoiceInputButton } from '@/atoms/VoiceInputButton.js';
import { useSpokenReply } from '@/components/SpokenReplyContext.js';
import {
  VoiceInputProvider,
  type VoiceAvailability,
  type VoiceInputApi,
  type VoiceTranscription,
} from '@/components/VoiceInputContext.js';
import { PUSH_TO_TALK_HOTKEY_STORAGE_KEY } from '@/utils/pushToTalkHotkey.js';
import { clearDraftFromVoice, setHandsFree, takeDraftFromVoice, voiceReplyDone } from '@/utils/voiceTurn.js';
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

describe('VoiceInputButton push-to-talk', () => {
  let requestSubmit: ReturnType<typeof vi.fn<(submitter?: HTMLElement | null) => void>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clearDraftFromVoice();
    window.localStorage.removeItem(PUSH_TO_TALK_HOTKEY_STORAGE_KEY);
    requestSubmit = vi.fn<(submitter?: HTMLElement | null) => void>();
    HTMLFormElement.prototype.requestSubmit = requestSubmit;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderInForm(api: VoiceInputApi) {
    return render(
      <form>
        <VoiceInputProvider api={api}>
          <VoiceInputButton disabled={false} />
        </VoiceInputProvider>
      </form>,
    );
  }

  // jsdom has no PointerEvent; a MouseEvent of the same type carries `button` the way a browser does.
  function pointer(target: Element, type: 'pointerdown' | 'pointerup') {
    fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('holding the mic and letting go sends the spoken words', async () => {
    const { api, transcribeMock } = makeApi();
    renderInForm(api);
    const mic = await screen.findByRole('button', { name: 'Record voice message' });

    pointer(mic, 'pointerdown');
    await screen.findByRole('button', { name: 'Stop and transcribe' });
    vi.setSystemTime(Date.now() + HOLD_TO_SEND_MS);
    pointer(screen.getByRole('button', { name: 'Stop and transcribe' }), 'pointerup');

    await screen.findByRole('button', { name: 'Record voice message' });
    await settle();
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(mockSetText).toHaveBeenCalledWith('existing draft hello world');
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it('a short press is a tap: recording goes on and nothing is sent', async () => {
    const { api, transcribeMock } = makeApi();
    renderInForm(api);
    const mic = await screen.findByRole('button', { name: 'Record voice message' });

    pointer(mic, 'pointerdown');
    const recording = await screen.findByRole('button', { name: 'Stop and transcribe' });
    pointer(recording, 'pointerup');
    fireEvent.click(recording, { detail: 1 });

    expect(screen.getByRole('button', { name: 'Stop and transcribe' })).toBeInTheDocument();
    expect(transcribeMock).not.toHaveBeenCalled();

    // The next tap puts the words in the box without sending them.
    fireEvent.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
    await screen.findByRole('button', { name: 'Record voice message' });
    await settle();
    expect(mockSetText).toHaveBeenCalledWith('existing draft hello world');
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('holding the hotkey records and letting go of Space sends', async () => {
    const { api } = makeApi();
    renderInForm(api);
    await screen.findByRole('button', { name: 'Record voice message' });

    fireEvent.keyDown(window, { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true });
    await screen.findByRole('button', { name: 'Stop and transcribe' });
    vi.setSystemTime(Date.now() + HOLD_TO_SEND_MS);
    fireEvent.keyUp(window, { code: 'Space', key: ' ' });

    await screen.findByRole('button', { name: 'Record voice message' });
    await settle();
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it('the hotkey does nothing when switched off', async () => {
    window.localStorage.setItem(PUSH_TO_TALK_HOTKEY_STORAGE_KEY, 'off');
    const { api } = makeApi();
    renderInForm(api);
    await screen.findByRole('button', { name: 'Record voice message' });

    fireEvent.keyDown(window, { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true });
    await settle();
    expect(mockStartVoiceRecording).not.toHaveBeenCalled();
  });

  it('the hotkey is left to the page when the mic cannot act', async () => {
    const { api } = makeApi();
    render(
      <form>
        <VoiceInputProvider api={api}>
          <VoiceInputButton disabled />
        </VoiceInputProvider>
      </form>,
    );
    await screen.findByRole('button', { name: 'Record voice message' });

    const event = new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true, shiftKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(mockStartVoiceRecording).not.toHaveBeenCalled();
  });

  it('an empty transcript is never sent', async () => {
    const { api } = makeApi({ transcribe: async () => ({ ...DEFAULT_TRANSCRIPTION, text: '  ' }) });
    renderInForm(api);
    const mic = await screen.findByRole('button', { name: 'Record voice message' });

    pointer(mic, 'pointerdown');
    await screen.findByRole('button', { name: 'Stop and transcribe' });
    vi.setSystemTime(Date.now() + HOLD_TO_SEND_MS);
    pointer(screen.getByRole('button', { name: 'Stop and transcribe' }), 'pointerup');

    await screen.findByRole('button', { name: 'Record voice message' });
    await settle();
    expect(requestSubmit).not.toHaveBeenCalled();
  });
});

describe('VoiceInputButton hands-free', () => {
  let silence: ((event: 'pause' | 'quiet') => void) | undefined;

  beforeEach(() => {
    clearDraftFromVoice();
    setHandsFree('off');
    silence = undefined;
    mockStartVoiceRecording.mockImplementation(async (options: StartVoiceRecordingOptions) => {
      silence = options.onSilence;
      return makeRecorder();
    });
    // Stands in for the composer: a send takes the voice draft.
    HTMLFormElement.prototype.requestSubmit = vi.fn<(submitter?: HTMLElement | null) => void>(() => {
      takeDraftFromVoice();
    });
  });

  function composer(api: VoiceInputApi, { isRunning = false }: { isRunning?: boolean } = {}) {
    return (
      <form>
        <VoiceInputProvider api={api}>
          <VoiceInputButton disabled={isRunning} isRunning={isRunning} />
        </VoiceInputProvider>
      </form>
    );
  }

  async function startHandsFree() {
    const { api, transcribeMock } = makeApi();
    const view = render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start hands-free conversation' }));
    await screen.findByText('Listening. Pause to send.');
    return { api, transcribeMock, view };
  }

  it('tells the mic and the hands-free switch apart when pointed at', async () => {
    const { api } = makeApi();
    render(composer(api));
    fireEvent.mouseEnter(await screen.findByRole('button', { name: 'Record voice message' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Voice message: tap to record/);
    fireEvent.mouseLeave(screen.getByRole('button', { name: 'Record voice message' }));
    fireEvent.focus(screen.getByRole('button', { name: 'Start hands-free conversation' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Hands-free conversation: just talk/);
    expect(screen.queryByTitle(/./)).toBeNull();
  });

  it('shows no mic hint while recording, since a hold and a tap end differently', async () => {
    const { api } = makeApi();
    render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }), { detail: 0 });
    const stop = await screen.findByRole('button', { name: 'Stop and transcribe' });
    fireEvent.mouseEnter(stop);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('sends on a pause, waits for the answer, then listens again', async () => {
    const { transcribeMock } = await startHandsFree();
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(1);

    act(() => silence?.('pause'));
    await screen.findByText('Waiting for the answer…');
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(HTMLFormElement.prototype.requestSubmit).toHaveBeenCalledTimes(1);

    act(() => voiceReplyDone());
    await screen.findByText('Listening. Pause to send.');
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(2);
  });

  it('stops after a long quiet and says how to start again', async () => {
    await startHandsFree();

    act(() => silence?.('quiet'));

    expect(await screen.findByText(/Hands-free stopped because it was quiet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start hands-free conversation' })).toBeInTheDocument();
  });

  it('stops when the message could not be sent', async () => {
    HTMLFormElement.prototype.requestSubmit = vi.fn<(submitter?: HTMLElement | null) => void>();
    await startHandsFree();

    act(() => silence?.('pause'));

    expect(await screen.findByText(/could not be sent/)).toBeInTheDocument();
    act(() => voiceReplyDone());
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(1);
  });

  it('turning it off releases the mic and ends the conversation', async () => {
    await startHandsFree();
    const recorder = await mockStartVoiceRecording.mock.results[0]?.value;

    fireEvent.click(screen.getByRole('button', { name: 'Stop hands-free conversation' }));

    expect(recorder.cancel).toHaveBeenCalled();
    act(() => voiceReplyDone());
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(1);
  });

  it('switching chats ends the conversation and releases the mic', async () => {
    await startHandsFree();
    const recorder = await mockStartVoiceRecording.mock.results[0]?.value;

    // What the chat view does when the chat really changes.
    act(() => setHandsFree('off'));

    expect(recorder.cancel).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Start hands-free conversation' })).toBeInTheDocument();
  });

  it('keeps listening when the address changes without a chat switch, as when a new chat gets its id', async () => {
    await startHandsFree();
    const recorder = await mockStartVoiceRecording.mock.results[0]?.value;

    act(() => {
      window.dispatchEvent(new Event('trueforge:routechange'));
    });

    expect(recorder.cancel).not.toHaveBeenCalled();
    expect(screen.getByText('Listening. Pause to send.')).toBeInTheDocument();
  });

  function micOpening() {
    const recorder = makeRecorder();
    let open: () => void = () => {};
    mockStartVoiceRecording.mockImplementation(
      (options: StartVoiceRecordingOptions) =>
        new Promise(resolve => {
          silence = options.onSilence;
          open = () => resolve(recorder);
        }),
    );
    return { recorder, open: () => open() };
  }

  it('turning it off while the mic is still opening drops that recording', async () => {
    const mic = micOpening();
    const { api } = makeApi();
    render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start hands-free conversation' }));

    fireEvent.click(screen.getByRole('button', { name: 'Stop hands-free conversation' }));
    await act(async () => {
      mic.open();
      await Promise.resolve();
    });
    act(() => silence?.('pause'));

    expect(mic.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(HTMLFormElement.prototype.requestSubmit).not.toHaveBeenCalled();
    expect(screen.queryByText('Listening. Pause to send.')).toBeNull();
  });

  it('hiding the tab while the mic is still opening drops that recording', async () => {
    const mic = micOpening();
    const { api } = makeApi();
    render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start hands-free conversation' }));

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      mic.open();
      await Promise.resolve();
    });
    visibility.mockRestore();
    act(() => silence?.('pause'));

    expect(mic.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(HTMLFormElement.prototype.requestSubmit).not.toHaveBeenCalled();
  });

  it('ends after 30 minutes and says how to start again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await startHandsFree();
      act(() => silence?.('pause'));
      await screen.findByText('Waiting for the answer…');

      vi.setSystemTime(Date.now() + HANDS_FREE_MAX_MS);
      act(() => voiceReplyDone());

      expect(await screen.findByText(/Hands-free stopped after 30 minutes/)).toBeInTheDocument();
      expect(mockStartVoiceRecording).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a turn sent by hand while listening stops the listen until it is answered', async () => {
    const { api, view } = await startHandsFree();
    const recorder = await mockStartVoiceRecording.mock.results[0]?.value;

    view.rerender(composer(api, { isRunning: true }));

    expect(recorder.cancel).toHaveBeenCalled();
    expect(await screen.findByText('Waiting for the answer…')).toBeInTheDocument();
    act(() => voiceReplyDone());
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(1);
    view.rerender(composer(api));
    await screen.findByText('Listening. Pause to send.');
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(2);
  });

  it('a reply read aloud by hand pauses the listen and it resumes after', async () => {
    installSpeechSynthesis();
    try {
      await startHandsFree();
      const recorder = await mockStartVoiceRecording.mock.results[0]?.value;

      const player = renderHook(() => useSpokenReply()).result.current;
      act(() => {
        void player.speak('A reply.', { key: 'msg-1' });
      });

      expect(recorder.cancel).toHaveBeenCalled();
      await screen.findByText('Waiting for the answer…');
      act(() => player.stop());
      await screen.findByText('Listening. Pause to send.');
      expect(mockStartVoiceRecording).toHaveBeenCalledTimes(2);
    } finally {
      stopSpokenReply();
      removeSpeechSynthesis();
    }
  });

  it('while Aman answers only the hands-free switch shows, and listening resumes after a remount', async () => {
    const { api, view } = await startHandsFree();
    act(() => silence?.('pause'));
    await screen.findByText('Waiting for the answer…');

    view.rerender(composer(api, { isRunning: true }));
    expect(screen.queryByRole('button', { name: 'Record voice message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop hands-free conversation' })).toBeInTheDocument();

    // An approval pause mounts a new composer; the conversation carries on there.
    view.unmount();
    render(composer(api));
    act(() => voiceReplyDone());
    await screen.findByText('Listening. Pause to send.');
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(2);
  });

  it('shows nothing while a turn runs when hands-free is off', async () => {
    const { api } = makeApi();
    const { container } = render(composer(api, { isRunning: true }));
    await settleAll();
    expect(container.querySelector('button')).toBeNull();
  });

  async function settleAll() {
    await act(async () => {
      await Promise.resolve();
    });
  }
});
