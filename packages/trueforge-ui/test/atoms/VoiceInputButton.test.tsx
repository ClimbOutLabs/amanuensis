import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSetText, mockStartVoiceRecording, mockStartLiveVoice, mockReload, mockSession, mockInitialize } =
  vi.hoisted(() => {
    const session: { remoteId: string | null } = { remoteId: 'chat-1' };
    return {
      mockInitialize: vi.fn(),
      mockSetText: vi.fn(),
      mockStartVoiceRecording: vi.fn(),
      mockStartLiveVoice: vi.fn(),
      mockReload: vi.fn(),
      mockSession: session,
    };
  });

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    composer: () => ({ setText: mockSetText }),
    threadListItem: () => ({ initialize: mockInitialize }),
  }),
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({ composer: { text: 'existing draft' }, threadListItem: { remoteId: mockSession.remoteId } }),
}));

vi.mock('@truefoundry/assistant-ui-runtime', () => ({ useTrueFoundryReload: () => mockReload }));

vi.mock('@/atoms/lib/liveVoice.js', () => ({ startLiveVoice: mockStartLiveVoice }));

vi.mock('@/atoms/lib/voiceRecorder.js', () => ({
  isVoiceCaptureSupported: () => true,
  startVoiceRecording: mockStartVoiceRecording,
}));

import type { LiveVoiceEvents } from '@/atoms/lib/liveVoice.js';
import type { StartVoiceRecordingOptions } from '@/atoms/lib/voiceRecorder.js';
import { HOLD_TO_SEND_MS, VoiceInputButton } from '@/atoms/VoiceInputButton.js';
import { useSpokenReply } from '@/components/SpokenReplyContext.js';
import {
  VoiceInputProvider,
  type VoiceAvailability,
  type VoiceInputApi,
  type VoiceTranscription,
} from '@/components/VoiceInputContext.js';
import { LiveVoiceBridge } from '@/containers/LiveVoiceBridge.js';
import { PUSH_TO_TALK_HOTKEY_STORAGE_KEY } from '@/utils/pushToTalkHotkey.js';
import { getVoiceMode, setVoiceMode } from '@/utils/voiceMode.js';
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
    connect: async () => ({ url: 'wss://aman.test/stream', protocols: [] }),
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

describe('VoiceInputButton voice mode', () => {
  const connection = { url: 'wss://aman.test/api/v1/voice/stream', protocols: ['aman-voice.v1', 'ticket.t1'] };
  let events: LiveVoiceEvents | undefined;
  let line: { stop: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    setVoiceMode('off');
    mockReload.mockClear();
    mockInitialize.mockReset();
    mockSession.remoteId = 'chat-1';
    events = undefined;
    line = { stop: vi.fn() };
    mockStartLiveVoice.mockReset();
    mockStartLiveVoice.mockImplementation(async (input: { events: LiveVoiceEvents }) => {
      events = input.events;
      return line;
    });
  });

  function makeVoiceApi(connect?: VoiceInputApi['connect']) {
    const { api } = makeApi();
    const connectMock = vi.fn(connect ?? (async () => connection));
    return { api: { ...api, connect: connectMock }, connectMock };
  }

  function composerOnly(api: VoiceInputApi, { isRunning = false }: { isRunning?: boolean } = {}) {
    return (
      <form>
        <VoiceInputProvider api={api}>
          <VoiceInputButton disabled={isRunning} isRunning={isRunning} />
        </VoiceInputProvider>
      </form>
    );
  }

  /** The chat as it stands: the bridge holds the line, and the composer comes and goes under it. */
  function chat(inner: ReactNode) {
    return (
      <>
        <LiveVoiceBridge />
        {inner}
      </>
    );
  }

  function composer(api: VoiceInputApi, options: { isRunning?: boolean } = {}) {
    return chat(composerOnly(api, options));
  }

  async function startVoiceMode() {
    const made = makeVoiceApi();
    const view = render(composer(made.api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    await screen.findByText('Listening');
    return { ...made, view };
  }

  it('tells the mic and the voice mode switch apart when pointed at', async () => {
    const { api } = makeVoiceApi();
    render(composer(api));
    fireEvent.mouseEnter(await screen.findByRole('button', { name: 'Record voice message' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Voice message: tap to record/);
    fireEvent.mouseLeave(screen.getByRole('button', { name: 'Record voice message' }));
    fireEvent.focus(screen.getByRole('button', { name: 'Start voice mode' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Voice mode: just talk/);
    expect(screen.queryByTitle(/./)).toBeNull();
  });

  it('shows no mic hint while recording, since a hold and a tap end differently', async () => {
    const { api } = makeVoiceApi();
    render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }), { detail: 0 });
    const stop = await screen.findByRole('button', { name: 'Stop and transcribe' });
    fireEvent.mouseEnter(stop);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('asks the server for a line to this chat and starts listening', async () => {
    const { connectMock } = await startVoiceMode();
    expect(connectMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-1' }));
    expect(mockStartLiveVoice).toHaveBeenCalledWith(expect.objectContaining({ connection }));
    expect(screen.getByRole('button', { name: 'End voice mode' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('follows the calm states the server reports', async () => {
    await startVoiceMode();
    act(() => events?.onState('thinking'));
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    act(() => events?.onState('speaking'));
    expect(screen.getByText('Speaking. Talk to interrupt.')).toBeInTheDocument();
    act(() => events?.onState('listening'));
    expect(screen.getByText('Listening')).toBeInTheDocument();
  });

  it('one tap ends it and releases the line', async () => {
    await startVoiceMode();
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode' }));
    expect(line.stop).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Start voice mode' })).toBeInTheDocument();
    expect(getVoiceMode()).toBe('off');
  });

  it('refreshes the chat when a spoken turn is saved', async () => {
    await startVoiceMode();
    act(() => events?.onTurnSaved());
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('says what to do when the line closes', async () => {
    await startVoiceMode();
    act(() => events?.onEnded('closed'));
    expect(await screen.findByText(/connection closed/)).toBeInTheDocument();
    expect(getVoiceMode()).toBe('off');
  });

  it('creates the chat first when it is new, the way the first send does, and talks in it', async () => {
    mockSession.remoteId = null;
    mockInitialize.mockResolvedValue({ remoteId: 'fresh-chat', externalId: undefined });
    const { api, connectMock } = makeVoiceApi();
    render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    await screen.findByText('Listening');
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'fresh-chat' }));
    expect(screen.queryByText(/Send a first message/)).toBeNull();
  });

  it('does not create another chat when one is already open', async () => {
    await startVoiceMode();
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('shows an error and stays off when the new chat cannot be created', async () => {
    mockSession.remoteId = null;
    mockInitialize.mockRejectedValue(new Error('Could not start a chat. Try again.'));
    const { api, connectMock } = makeVoiceApi();
    render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start a chat. Try again.');
    expect(connectMock).not.toHaveBeenCalled();
    expect(getVoiceMode()).toBe('off');
  });

  it('shows the server message when the line is refused', async () => {
    const { api } = makeVoiceApi(async () => {
      throw new Error('Voice mode is turned off on this computer.');
    });
    render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Voice mode is turned off on this computer.');
    expect(getVoiceMode()).toBe('off');
  });

  it('ending it while the line is still opening closes the line when it opens', async () => {
    let opened: (() => void) | undefined;
    mockStartLiveVoice.mockImplementation(
      () =>
        new Promise(resolve => {
          opened = () => resolve(line);
        }),
    );
    const { api } = makeVoiceApi();
    render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    fireEvent.click(await screen.findByRole('button', { name: 'End voice mode' }));
    await act(async () => {
      opened?.();
      await Promise.resolve();
    });
    expect(line.stop).toHaveBeenCalledTimes(1);
    expect(getVoiceMode()).toBe('off');
  });

  it('taking the mic by hand ends voice mode', async () => {
    await startVoiceMode();
    fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));
    expect(line.stop).toHaveBeenCalledTimes(1);
    expect(getVoiceMode()).toBe('off');
  });

  it('switching chats ends it', async () => {
    const { api } = makeVoiceApi();
    const view = render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    await screen.findByText('Listening');
    mockSession.remoteId = 'chat-2';
    view.rerender(composer(api));
    expect(line.stop).toHaveBeenCalledTimes(1);
    expect(getVoiceMode()).toBe('off');
  });

  it('keeps going when the composer is rebuilt in another place, as it is when an approval card appears', async () => {
    const { api } = makeVoiceApi();
    const view = render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    await screen.findByText('Listening');
    view.rerender(chat(<div data-testid="approval-view">{composerOnly(api)}</div>));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(line.stop).not.toHaveBeenCalled();
    expect(getVoiceMode()).toBe('listening');
    expect(screen.getByRole('button', { name: 'End voice mode' })).toBeInTheDocument();
    // What the line reports now reaches the new composer.
    act(() => events?.onTurnSaved());
    expect(mockReload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode' }));
    expect(line.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps going while the composer is gone for longer than a moment, as it is while the chat reloads', async () => {
    const { api } = makeVoiceApi();
    const view = render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    await screen.findByText('Listening');
    view.rerender(chat(<div data-testid="loading" />));
    for (let task = 0; task < 3; task += 1) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
      });
    }
    expect(line.stop).not.toHaveBeenCalled();
    // The reload that follows a spoken turn happens while there is no composer.
    act(() => events?.onTurnSaved());
    expect(mockReload).toHaveBeenCalledTimes(1);
    view.rerender(composer(api));
    expect(screen.getByRole('button', { name: 'End voice mode' })).toBeInTheDocument();
    expect(getVoiceMode()).toBe('listening');
  });

  it('shows what the line says even when it said it while the composer was gone', async () => {
    const { api } = makeVoiceApi();
    const view = render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    await screen.findByText('Listening');
    view.rerender(chat(<div />));
    act(() => events?.onNotice('I could not hear that.'));
    view.rerender(composer(api));
    expect(await screen.findByText('I could not hear that.')).toBeInTheDocument();
  });

  it('ends when the chat itself goes away', async () => {
    const { api } = makeVoiceApi();
    const view = render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    await screen.findByText('Listening');
    view.unmount();
    expect(line.stop).toHaveBeenCalledTimes(1);
    expect(getVoiceMode()).toBe('off');
  });

  it('is set back to off, and says why, when the line fails to open after the composer was rebuilt', async () => {
    let fail: (error: Error) => void = () => undefined;
    const { api } = makeVoiceApi(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const view = render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    view.rerender(chat(<div data-testid="approval-view">{composerOnly(api)}</div>));
    await act(async () => {
      fail(new Error('Voice mode is turned off on this computer.'));
      await Promise.resolve();
    });
    expect(getVoiceMode()).toBe('off');
    expect(await screen.findByRole('button', { name: 'Start voice mode' })).toBeInTheDocument();
  });

  it('does not open a line for the old chat when another chat is shown while it is connecting', async () => {
    let open: () => void = () => undefined;
    const { api } = makeVoiceApi(
      () =>
        new Promise(resolve => {
          open = () => resolve(connection);
        }),
    );
    const view = render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    mockSession.remoteId = 'chat-2';
    view.rerender(composer(api));
    await act(async () => {
      open();
      await Promise.resolve();
    });
    await waitFor(() => expect(getVoiceMode()).toBe('off'));
  });

  it('a quick off and on again leaves one line, not two', async () => {
    const opens: (() => void)[] = [];
    const lines = [{ stop: vi.fn() }, { stop: vi.fn() }];
    mockStartLiveVoice.mockImplementation(
      () =>
        new Promise(resolve => {
          const next = lines[opens.length];
          opens.push(() => resolve(next));
        }),
    );
    const { api } = makeVoiceApi();
    render(composer(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    await waitFor(() => expect(opens).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice mode' }));
    await waitFor(() => expect(opens).toHaveLength(2));
    await act(async () => {
      opens[0]?.();
      opens[1]?.();
      await Promise.resolve();
    });
    expect(lines[0]?.stop).toHaveBeenCalledTimes(1);
    expect(lines[1]?.stop).not.toHaveBeenCalled();
    expect(getVoiceMode()).toBe('listening');
  });

  it('hiding the tab ends it', async () => {
    await startVoiceMode();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(line.stop).toHaveBeenCalledTimes(1);
  });

  it('while a turn runs only the voice mode switch shows, and nothing shows with voice mode off', async () => {
    const { api } = makeVoiceApi();
    const view = render(composer(api, { isRunning: true }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.querySelector('button')).toBeNull();
  });
});
