// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PersonaProvider, type PersonaApi } from '@/components/PersonaContext.js';
import { SpokenReplyProvider } from '@/components/SpokenReplyContext.js';
import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import type { ServerVoiceApi } from '@/utils/spokenReplyPlayer.js';
import { personaApiStubs } from '../personaApiStubs.js';
import {
  installSpeechSynthesis,
  removeSpeechSynthesis,
  spokenTexts,
  stopSpokenReply,
  type FakeSpeechSynthesis,
} from '../utils/speechSynthesisFake.js';
import { RuntimeHarness } from './RuntimeHarness.js';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ state }: { state: string }) => <div data-testid="thinking-orb" data-state={state} />,
}));

const answer: ThreadMessageLike[] = [
  { role: 'user', id: 'user-1', content: [{ type: 'text', text: 'Plan my week' }] },
  {
    role: 'assistant',
    id: 'assistant-1',
    content: [{ type: 'text', text: 'Here is the **plan** for [your week](https://example.com).' }],
    status: { type: 'complete', reason: 'stop' },
    metadata: { custom: { turnId: 'turn-1' } },
  },
];

/** Zara has her own voice and wrote the answer in turn-1. */
function zaraApi(): PersonaApi {
  const unused = () => Promise.reject(new Error('not used in this test'));
  return {
    ...personaApiStubs,
    listPersonas: () =>
      Promise.resolve([
        { id: 'p-zara', display_name: 'Zara', aliases: [], instructions: '', model_name: 'm/m', voice: 'am_michael' },
      ]),
    createPersona: unused,
    updatePersona: unused,
    deletePersona: unused,
    getSessionPersona: () => Promise.resolve(null),
    setSessionPersona: unused,
    getTurnPersona: () => Promise.resolve({ persona_id: 'p-zara' }),
  };
}

function renderAnswer({ serverVoice, personas }: { serverVoice?: ServerVoiceApi; personas?: PersonaApi } = {}) {
  const messages = (
    <RuntimeHarness messages={answer} isRunning={false} threadId="chat-a" remoteId="session-a">
      <ThreadPrimitive.Messages>
        {({ message }) => (message.role === 'assistant' ? <AssistantMessageContainer /> : null)}
      </ThreadPrimitive.Messages>
    </RuntimeHarness>
  );
  const thread = personas === undefined ? messages : <PersonaProvider api={personas}>{messages}</PersonaProvider>;
  return render(
    serverVoice === undefined ? thread : <SpokenReplyProvider serverVoice={serverVoice}>{thread}</SpokenReplyProvider>,
  );
}

describe('finished answer read-aloud controls', () => {
  let synthesis: FakeSpeechSynthesis;

  beforeEach(() => {
    synthesis = installSpeechSynthesis();
  });

  afterEach(() => {
    stopSpokenReply();
    vi.restoreAllMocks();
    removeSpeechSynthesis();
    window.localStorage.clear();
  });

  it('reads the answer aloud on demand and offers a stop while it is read', () => {
    renderAnswer();

    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));

    expect(spokenTexts(synthesis)).toEqual(['Here is the plan for your week.']);
    const stop = screen.getByRole('button', { name: 'Stop reading aloud' });

    fireEvent.click(stop);

    expect(synthesis.cancel).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeInTheDocument();
  });

  it('shows no read-aloud control when the browser cannot read text aloud', () => {
    removeSpeechSynthesis();

    renderAnswer();

    expect(screen.queryByRole('button', { name: 'Read aloud' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop reading aloud' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('reads the answer with the computer voice when the host has one, and not the browser voice', async () => {
    const speak = vi.fn<ServerVoiceApi['speak']>(() => Promise.resolve(new Blob(['wav'], { type: 'audio/wav' })));
    removeSpeechSynthesis();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    renderAnswer({ serverVoice: { speak } });

    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));

    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(speak.mock.lastCall?.[0].text).toBe('Here is the plan for your week.');
  });

  it('reads a persona’s answer in the voice picked for that persona', async () => {
    const speak = vi.fn<ServerVoiceApi['speak']>(() => Promise.resolve(new Blob(['wav'], { type: 'audio/wav' })));
    removeSpeechSynthesis();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    renderAnswer({ serverVoice: { speak }, personas: zaraApi() });
    // The persona list loads first; until then there is no persona voice to look up.
    await new Promise(resolve => setTimeout(resolve, 0));

    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));

    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(speak.mock.lastCall?.[0].voice).toBe('am_michael');
  });

  it('falls back to the browser voice when the computer voice fails', async () => {
    const speak = vi.fn<ServerVoiceApi['speak']>(() => Promise.reject(new Error('voice is off')));
    renderAnswer({ serverVoice: { speak } });

    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));

    await vi.waitFor(() => expect(spokenTexts(synthesis)).toEqual(['Here is the plan for your week.']));
  });
});
