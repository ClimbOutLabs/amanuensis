// @vitest-environment jsdom
import type { RespondToToolApprovalOptions, ThreadMessageLike } from '@assistant-ui/react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PersonaProvider, type Persona, type PersonaApi } from '@/components/PersonaContext.js';
import { SpokenReplyProvider } from '@/components/SpokenReplyContext.js';
import { SpokenReplyContainer } from '@/containers/SpokenReplyContainer.js';
import { SERVER_VOICE_STORAGE_KEY, SPEAK_VOICE_REPLIES_STORAGE_KEY } from '@/utils/speechReplyPreferences.js';
import type { ServerVoiceApi } from '@/utils/spokenReplyPlayer.js';
import {
  armSpokenReply,
  clearDraftFromVoice,
  disarmSpokenReply,
  getHandsFree,
  markDraftFromVoice,
  setHandsFree,
  takeDraftFromVoice,
} from '@/utils/voiceTurn.js';
import { personaApiStubs } from '../personaApiStubs.js';
import {
  installSpeechSynthesis,
  removeSpeechSynthesis,
  spokenTexts,
  stopSpokenReply,
  type FakeSpeechSynthesis,
} from '../utils/speechSynthesisFake.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const { threadRunning, approvals } = vi.hoisted(() => {
  const threadRunning = { value: false };
  // Approval cards come from the sentinel provider; speech only reads the card's plain sentence.
  const approvals: Record<string, { card: { plain_what: string } }> = {};
  return { threadRunning, approvals };
});

vi.mock('@assistant-ui/core/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@assistant-ui/core/react')>()),
  useThreadIsRunning: () => threadRunning.value,
}));

vi.mock('@/sentinel/SentinelStateProvider.js', () => ({
  useOptionalSentinelState: () => ({ approvalFor: (toolCallId: string) => approvals[toolCallId] }),
}));

const COMPLETE = { type: 'complete' as const, reason: 'stop' as const };

const userMessage = (text: string): ThreadMessageLike => ({
  role: 'user',
  id: 'user-1',
  content: [{ type: 'text', text }],
});

const assistantMessage = (content: ThreadMessageLike['content']): ThreadMessageLike => ({
  role: 'assistant',
  id: 'assistant-1',
  content,
  status: COMPLETE,
});

const streamingMessage = (content: ThreadMessageLike['content']): ThreadMessageLike => ({
  role: 'assistant',
  id: 'assistant-1',
  content,
  status: { type: 'running' },
});

const calendarCall = {
  type: 'tool-call' as const,
  toolCallId: 'call-1',
  toolName: 'list_events',
  args: {},
  argsText: '{}',
};

function thread({
  messages,
  running,
  onRespondToToolApproval,
  threadId,
}: {
  messages: ThreadMessageLike[];
  running: boolean;
  onRespondToToolApproval?: (options: RespondToToolApprovalOptions) => void;
  threadId?: string;
}) {
  threadRunning.value = running;
  return (
    <RuntimeHarness
      messages={messages}
      isRunning={running}
      onRespondToToolApproval={onRespondToToolApproval}
      threadId={threadId}
    >
      <SpokenReplyContainer />
    </RuntimeHarness>
  );
}

/** The runtime publishes message updates on the next tick, so assertions wait for it. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

const PROMPT = 'Check my calendar';

/**
 * Mirrors the composer send path: the draft's voice flag arms the send, its message reaches the chat,
 * the reply streams in while the turn runs, then the turn ends with the reply complete.
 */
async function sendAndFinish({ fromVoice, reply }: { fromVoice: boolean; reply: ThreadMessageLike['content'] }) {
  if (fromVoice) markDraftFromVoice();
  const { rerender } = render(thread({ messages: [], running: false }));
  armSpokenReply({ fromVoice: takeDraftFromVoice(), text: PROMPT });
  const prompt = [userMessage(PROMPT)];
  rerender(thread({ messages: prompt, running: true }));
  await settle();
  rerender(thread({ messages: [...prompt, streamingMessage(reply)], running: true }));
  rerender(thread({ messages: [...prompt, assistantMessage(reply)], running: false }));
  await settle();
  return rerender;
}

describe('SpokenReplyContainer', () => {
  let synthesis: FakeSpeechSynthesis;

  beforeEach(() => {
    synthesis = installSpeechSynthesis();
  });

  afterEach(() => {
    stopSpokenReply();
    removeSpeechSynthesis();
    clearDraftFromVoice();
    setHandsFree('off');
    window.localStorage.clear();
    threadRunning.value = false;
  });

  it('reads the final answer of a turn that was sent from voice', async () => {
    await sendAndFinish({
      fromVoice: true,
      reply: [
        { type: 'text', text: 'Checking your calendar now.' },
        calendarCall,
        { type: 'text', text: 'You have **two** meetings [today](https://example.com).' },
      ],
    });

    expect(spokenTexts(synthesis)).toEqual(['You have two meetings today.']);
  });

  // The chat shows a sent message under a temporary id, then renames it to the server's turn id.
  it('reads the answer when the voice message is renamed while its turn runs', async () => {
    markDraftFromVoice();
    const reply = [{ type: 'text' as const, text: 'You have two meetings today.' }];
    const { rerender } = render(thread({ messages: [], running: false }));
    armSpokenReply({ fromVoice: takeDraftFromVoice(), text: PROMPT });
    rerender(thread({ messages: [userMessage(PROMPT)], running: true }));
    await settle();
    const renamed: ThreadMessageLike = { ...userMessage(PROMPT), id: 'turn-1-user' };
    rerender(thread({ messages: [renamed, streamingMessage(reply)], running: true }));
    await settle();
    rerender(thread({ messages: [renamed, assistantMessage(reply)], running: false }));
    await settle();

    expect(spokenTexts(synthesis)).toEqual(['You have two meetings today.']);
  });

  // The blocker: a voice send that never reached the chat left its flag set, so the next finished run was read aloud.
  it('does not read a later typed reply after a voice send that never went through', async () => {
    const { rerender } = render(thread({ messages: [], running: false }));
    armSpokenReply({ fromVoice: true, text: 'Check my calendar' });
    const typed = [userMessage('Typed instead')];

    rerender(thread({ messages: typed, running: true }));
    await settle();
    rerender(
      thread({ messages: [...typed, assistantMessage([{ type: 'text', text: 'Typed answer.' }])], running: false }),
    );
    await settle();

    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it('does not read a reply to a voice message that a failed send left behind', async () => {
    const { rerender } = render(thread({ messages: [], running: false }));
    armSpokenReply({ fromVoice: true, text: PROMPT });
    disarmSpokenReply();
    const prompt = [userMessage(PROMPT)];

    rerender(thread({ messages: prompt, running: true }));
    rerender(
      thread({ messages: [...prompt, assistantMessage([{ type: 'text', text: 'Late answer.' }])], running: false }),
    );
    await settle();

    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it('stops a reply in progress when the person switches chats', async () => {
    const rerender = await sendAndFinish({ fromVoice: true, reply: [{ type: 'text', text: 'Long answer here.' }] });
    expect(synthesis.speak).toHaveBeenCalledTimes(1);

    rerender(thread({ messages: [], running: false, threadId: 'chat-b' }));
    await settle();

    expect(synthesis.cancel).toHaveBeenCalled();
  });

  it('does not read a reply in a chat the person left before it finished', async () => {
    const { rerender } = render(thread({ messages: [], running: false, threadId: 'chat-a' }));
    armSpokenReply({ fromVoice: true, text: PROMPT });
    const prompt = [userMessage(PROMPT)];
    rerender(thread({ messages: prompt, running: true, threadId: 'chat-a' }));
    await settle();
    rerender(
      thread({
        messages: [...prompt, streamingMessage([{ type: 'text', text: 'Working.' }])],
        running: true,
        threadId: 'chat-a',
      }),
    );

    rerender(
      thread({
        messages: [userMessage('Other question'), assistantMessage([{ type: 'text', text: 'Other chat answer.' }])],
        running: false,
        threadId: 'chat-b',
      }),
    );
    await settle();

    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it('does not read a reply to a typed message', async () => {
    await sendAndFinish({ fromVoice: false, reply: [{ type: 'text', text: 'Hello there.' }] });

    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it('reads at most 60 words of a long answer and says where the rest is', async () => {
    const words = Array.from({ length: 80 }, (_, index) => `word${String(index)}`);
    await sendAndFinish({ fromVoice: true, reply: [{ type: 'text', text: words.join(' ') }] });

    expect(spokenTexts(synthesis)).toEqual([`${words.slice(0, 60).join(' ')}. The rest is on screen.`]);
  });

  it('speaks one short OK line for a reply that waits on an approval, and approves nothing', async () => {
    approvals['call-approval'] = { card: { plain_what: 'Send the email to Sam Rivera.' } };
    const respond = vi.fn<(options: RespondToToolApprovalOptions) => void>();
    const prompt = [userMessage('Email Sam')];
    const { rerender } = render(thread({ messages: [], running: false, onRespondToToolApproval: respond }));
    armSpokenReply({ fromVoice: true, text: 'Email Sam' });
    rerender(thread({ messages: prompt, running: true, onRespondToToolApproval: respond }));
    await settle();
    rerender(
      thread({
        messages: [
          ...prompt,
          assistantMessage([
            { type: 'text', text: 'I drafted it.' },
            {
              type: 'tool-call',
              toolCallId: 'call-approval',
              toolName: 'send_email',
              args: {},
              argsText: '{}',
              interrupt: { type: 'human', payload: {} },
              approval: { id: 'approval-1', options: [{ id: 'allow-once', kind: 'allow-once' }] },
            },
          ]),
        ],
        running: false,
        onRespondToToolApproval: respond,
      }),
    );

    await settle();
    expect(spokenTexts(synthesis)).toEqual(['Please approve this on screen: Send the email to Sam Rivera.']);
    expect(respond).not.toHaveBeenCalled();
    delete approvals['call-approval'];
  });

  it('stays silent when the person has switched voice replies off', async () => {
    window.localStorage.setItem(SPEAK_VOICE_REPLIES_STORAGE_KEY, 'false');

    await sendAndFinish({ fromVoice: true, reply: [{ type: 'text', text: 'Hello there.' }] });

    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it('does not speak or throw when the browser has no speech synthesis', async () => {
    removeSpeechSynthesis();

    await expect(
      sendAndFinish({ fromVoice: true, reply: [{ type: 'text', text: 'Hello there.' }] }),
    ).resolves.toBeDefined();
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it('a hands-free conversation listens again only once the reply has been read aloud', async () => {
    await sendAndFinishHandsFree();
    expect(getHandsFree()).toBe('answering');

    await act(async () => {
      for (const call of synthesis.speak.mock.calls) call[0].finish();
    });
    await settle();
    expect(getHandsFree()).toBe('listen-due');
  });

  it('a hands-free conversation listens again at once when there is nothing to read', async () => {
    window.localStorage.setItem(SPEAK_VOICE_REPLIES_STORAGE_KEY, 'false');

    await sendAndFinishHandsFree();

    expect(getHandsFree()).toBe('listen-due');
  });

  it('switching chats ends a hands-free conversation', async () => {
    const { rerender } = render(thread({ messages: [], running: false, threadId: 'chat-a' }));
    await settle();
    setHandsFree('answering');

    rerender(thread({ messages: [], running: false, threadId: 'chat-b' }));
    await settle();

    expect(getHandsFree()).toBe('off');
  });

  async function sendAndFinishHandsFree() {
    const { rerender } = render(thread({ messages: [], running: false }));
    setHandsFree('answering');
    markDraftFromVoice();
    armSpokenReply({ fromVoice: takeDraftFromVoice(), text: PROMPT });
    const prompt = [userMessage(PROMPT)];
    const reply = [{ type: 'text' as const, text: 'Hello there.' }];
    rerender(thread({ messages: prompt, running: true }));
    await settle();
    rerender(thread({ messages: [...prompt, assistantMessage(reply)], running: false }));
    await settle();
  }
});

describe('SpokenReplyContainer with personas', () => {
  const PERSONA: Persona = {
    id: 'p-zara',
    display_name: 'Zara',
    aliases: [],
    instructions: 'Answer plainly.',
    model_name: 'scripted/model',
    voice: 'af_bella',
  };

  function voiceServer(): ServerVoiceApi & { voices: string[] } {
    const voices: string[] = [];
    return {
      voices,
      speak: ({ voice }) => {
        voices.push(voice);
        return Promise.resolve(new Blob(['clip'], { type: 'audio/wav' }));
      },
    };
  }

  function personaApi(answeredBy: string | null): PersonaApi & { turnLookups: string[] } {
    const turnLookups: string[] = [];
    const unused = () => Promise.reject(new Error('not used in this test'));
    return {
      ...personaApiStubs,
      turnLookups,
      listPersonas: () => Promise.resolve([PERSONA]),
      createPersona: unused,
      updatePersona: unused,
      deletePersona: unused,
      getSessionPersona: () => Promise.resolve(null),
      setSessionPersona: unused,
      getTurnPersona: ({ sessionId, turnId }) => {
        turnLookups.push(`${sessionId}/${turnId}`);
        return Promise.resolve({ persona_id: answeredBy });
      },
    };
  }

  const reply = (turnId: string): ThreadMessageLike => ({
    ...assistantMessage([{ type: 'text', text: 'Here is the answer.' }]),
    metadata: { custom: { turnId } },
  });

  async function voiceTurn({ api, server }: { api: PersonaApi; server: ServerVoiceApi }) {
    const view = (messages: ThreadMessageLike[], running: boolean) => {
      threadRunning.value = running;
      return (
        <PersonaProvider api={api}>
          <SpokenReplyProvider serverVoice={server}>
            <RuntimeHarness messages={messages} isRunning={running} threadId="chat-a" remoteId="session-a">
              <SpokenReplyContainer />
            </RuntimeHarness>
          </SpokenReplyProvider>
        </PersonaProvider>
      );
    };
    const { rerender } = render(view([], false));
    await settle();
    armSpokenReply({ fromVoice: true, text: PROMPT });
    const prompt = [userMessage(PROMPT)];
    rerender(view(prompt, true));
    await settle();
    rerender(view([...prompt, reply('turn-1')], false));
    await settle();
    await settle();
  }

  beforeEach(() => {
    // jsdom cannot play audio; only which voice was asked for matters here.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('no audio in tests'));
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stopSpokenReply();
    window.localStorage.clear();
    threadRunning.value = false;
  });

  it('reads a reply in the voice picked for the persona that wrote it', async () => {
    const api = personaApi('p-zara');
    const server = voiceServer();
    window.localStorage.setItem(SERVER_VOICE_STORAGE_KEY, 'am_fenrir');

    await voiceTurn({ api, server });

    expect(api.turnLookups).toEqual(['session-a/turn-1']);
    expect(server.voices[0]).toBe('af_bella');
  });

  it('reads a reply from the main assistant in the person’s own voice choice', async () => {
    const server = voiceServer();
    window.localStorage.setItem(SERVER_VOICE_STORAGE_KEY, 'am_fenrir');

    await voiceTurn({ api: personaApi(null), server });

    expect(server.voices[0]).toBe('am_fenrir');
  });

  it('still reads the reply, in the person’s own voice, when the persona lookup fails', async () => {
    const api: PersonaApi = { ...personaApi('p-zara'), getTurnPersona: () => Promise.reject(new Error('offline')) };
    const server = voiceServer();

    await voiceTurn({ api, server });

    expect(server.voices[0]).toBe('af_heart');
  });
});
