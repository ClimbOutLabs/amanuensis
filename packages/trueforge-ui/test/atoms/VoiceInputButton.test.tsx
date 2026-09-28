import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { VoiceInputButton } from '@/atoms/VoiceInputButton.js';
import {
  VoiceInputProvider,
  type VoiceInputApi,
  type VoiceStatus,
  type VoiceTranscription,
} from '@/components/VoiceInputContext.js';

const DEFAULT_TRANSCRIPTION: VoiceTranscription = {
  text: 'hello world',
  language: 'en',
  duration_ms: 5,
  model: 'm',
};

function makeApi({
  getStatus,
  transcribe,
}: {
  getStatus?: () => Promise<VoiceStatus>;
  transcribe?: (input: { audio: Blob; language?: string }) => Promise<VoiceTranscription>;
} = {}) {
  const transcribeMock = vi.fn(transcribe ?? (async () => DEFAULT_TRANSCRIPTION));
  const api: VoiceInputApi = {
    getStatus: getStatus ?? (async () => ({ stt_available: true, model: 'whisper-small-int8' })),
    transcribe: transcribeMock,
  };
  return { api, transcribeMock };
}

function makeRecorder() {
  return {
    stop: vi.fn().mockResolvedValue(new Blob(['audio'], { type: 'audio/wav' })),
    cancel: vi.fn(),
  };
}

beforeEach(() => {
  mockSetText.mockClear();
  mockStartVoiceRecording.mockReset();
  mockStartVoiceRecording.mockResolvedValue(makeRecorder());
});

describe('VoiceInputButton', () => {
  it('renders nothing when no voice input provider is wired', () => {
    const { container } = render(<VoiceInputButton disabled={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a disabled mic with a tooltip when STT is unavailable', async () => {
    const { api } = makeApi({ getStatus: () => Promise.resolve({ stt_available: false, model: '' }) });
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    const button = await screen.findByRole('button', { name: 'Voice input unavailable' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Voice input unavailable');
  });

  it('records, transcribes, and appends the transcript to the draft', async () => {
    const { api, transcribeMock } = makeApi();
    render(
      <VoiceInputProvider api={api}>
        <VoiceInputButton disabled={false} />
      </VoiceInputProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Record voice message' }));
    expect(mockStartVoiceRecording).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording and transcribe' }));
    expect(await screen.findByRole('button', { name: 'Record voice message' })).toBeEnabled();
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    const audio = transcribeMock.mock.calls[0]?.[0].audio;
    expect(audio).toBeInstanceOf(Blob);
    expect(mockSetText).toHaveBeenCalledWith('existing draft hello world');
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
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording and transcribe' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Transcription failed, try again or type instead');
    expect(transcribeMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss transcription error' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a mic error when capture cannot start', async () => {
    mockStartVoiceRecording.mockRejectedValueOnce(new Error('denied'));
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
