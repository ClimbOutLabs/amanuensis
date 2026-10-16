// @vitest-environment jsdom
import { useAui, type AppendMessage, type ThreadMessageLike } from '@assistant-ui/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceInputProvider, type VoiceAvailability, type VoiceInputApi } from '@/components/VoiceInputContext.js';
import { canSubmitComposer, ComposerContainer } from '@/containers/ComposerContainer.js';
import { ToasterProvider } from '@/containers/ToasterContainer.js';
import { ComposerBusyProvider, notifyComposerBusyFailure } from '@/hooks/useComposerBusyState.js';
import { composerDraftKey, ComposerDraftScopeProvider } from '@/hooks/useComposerDraft.js';
import {
  CustomActionRenderersProvider,
  type CustomActionRendererProps,
} from '@/server/CustomActionRenderersContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, type AgentConfig } from '@/server/ShellModeContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { createMockAgentUIServer } from '../server/mockServer.js';
import { RuntimeHarness } from './RuntimeHarness.js';

/** Stands in for the chat runtime's own restore (`onPreTurnFailure` in
 *  `@truefoundry/assistant-ui-runtime`): a button that puts text straight into the composer via
 *  `aui.composer().setText`, the same call the runtime makes. */
function RestoreTextButton({ text }: { text: string }) {
  const aui = useAui();
  return (
    <button type="button" onClick={() => aui.composer().setText(text)}>
      restore
    </button>
  );
}

const agentSpecState: { agentSpec: { model: { name: string } } | undefined } = {
  agentSpec: { model: { name: 'test/model' } },
};
const updateAgentSpec = vi.hoisted(() => vi.fn());
const cancelRun = vi.hoisted(() => vi.fn<() => Promise<void>>());

const voiceCapture = vi.hoisted(() => ({ supported: true }));

const toolResponsesState = vi.hoisted(() => ({
  pending: [] as Array<{ toolCallId: string; toolName?: string; args?: Record<string, unknown> }>,
  respond: vi.fn(),
}));

const approvalsState = vi.hoisted(() => ({
  pending: [] as Array<{
    approvalId: string;
    threadId: string;
    toolName: string;
    args: Record<string, unknown>;
    argsText: string;
  }>,
}));

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryCancel: () => cancelRun,
  useTrueFoundryToolResponses: () => toolResponsesState,
  useTrueFoundryApprovals: () => approvalsState,
  useTrueFoundryAgentSpec: () => ({ agentSpec: agentSpecState.agentSpec }),
  useTrueFoundryUpdateAgentSpec: () => updateAgentSpec,
}));

vi.mock('@/atoms/lib/voiceRecorder.js', () => ({
  isVoiceCaptureSupported: () => voiceCapture.supported,
  startVoiceRecording: vi.fn(),
}));

function SecretSelectProbe({ onSubmit }: CustomActionRendererProps) {
  return (
    <button type="button" onClick={() => onSubmit('chosen-secret')}>
      Secret selector
    </button>
  );
}

function renderComposer(onNew?: (message: AppendMessage) => Promise<void>, messages: ThreadMessageLike[] = []) {
  return render(
    <RuntimeHarness messages={messages} onNew={onNew}>
      <ComposerBusyProvider>
        <ComposerContainer />
      </ComposerBusyProvider>
    </RuntimeHarness>,
  );
}

function draftKeys(): string[] {
  return Object.keys(window.sessionStorage).filter(key => key.startsWith('aman:composer-draft:'));
}

function onlyDraftKey(): string {
  const keys = draftKeys();
  expect(keys).toHaveLength(1);
  return keys[0] ?? '';
}

// The harness runtime does not expose its thread id, so the key is learned from a first write.
async function draftKeyOf(mount: () => { unmount: () => void }): Promise<string> {
  const view = mount();
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
  fireEvent.change(input, { target: { value: 'probe' } });
  const key = onlyDraftKey();
  fireEvent.change(input, { target: { value: '' } });
  await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
  view.unmount();
  return key;
}

describe('canSubmitComposer', () => {
  it.each([
    { name: 'New Chat', requiresModel: true, hasModel: true },
    { name: 'Try Agent', requiresModel: false, hasModel: false },
    { name: 'Build Agent', requiresModel: true, hasModel: true },
  ])('allows attachment-only submission in $name', ({ requiresModel, hasModel }) => {
    expect(
      canSubmitComposer({
        disabled: false,
        hasText: false,
        hasAttachments: true,
        requiresModel,
        hasModel,
      }),
    ).toBe(true);
  });

  it('blocks empty messages and mutable drafts without a model', () => {
    expect(
      canSubmitComposer({
        disabled: false,
        hasText: false,
        hasAttachments: false,
        requiresModel: false,
        hasModel: false,
      }),
    ).toBe(false);
    expect(
      canSubmitComposer({
        disabled: false,
        hasText: false,
        hasAttachments: true,
        requiresModel: true,
        hasModel: false,
      }),
    ).toBe(false);
  });
});

describe('ComposerContainer', () => {
  beforeEach(() => {
    agentSpecState.agentSpec = { model: { name: 'test/model' } };
    toolResponsesState.pending = [];
    toolResponsesState.respond = vi.fn();
    approvalsState.pending = [];
    cancelRun.mockReset();
    cancelRun.mockResolvedValue();
    updateAgentSpec.mockReset();
    window.sessionStorage.clear();
  });

  it('puts back the draft saved for this conversation, as after a reload or a sign-in round trip', async () => {
    const key = await draftKeyOf(renderComposer);
    window.sessionStorage.setItem(key, 'Madrid rental requirements: two bedrooms');
    renderComposer();
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    await waitFor(() => expect(input.value).toBe('Madrid rental requirements: two bedrooms'));
    expect(window.sessionStorage.getItem(key)).toBe('Madrid rental requirements: two bedrooms');
  });

  it('saves the draft as it is typed and drops it once the user empties the box', async () => {
    renderComposer();
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'first line' } });
    const key = onlyDraftKey();
    expect(window.sessionStorage.getItem(key)).toBe('first line');

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
  });

  it('keeps the draft through a send until the turn starts, then drops it', async () => {
    const onNew = vi.fn(async () => {});
    const view = render(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'send me' } });
    const key = onlyDraftKey();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input.value).toBe(''));
    // The composer is empty but nothing has been accepted yet: a 401 redirect here must still
    // find the text on the way back.
    expect(window.sessionStorage.getItem(key)).toBe('send me');

    view.rerender(
      <RuntimeHarness messages={[]} isRunning onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
  });

  it('gives the text back when the send fails before a turn starts', async () => {
    const onNew = vi.fn(async () => {});
    const view = renderComposer(onNew);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'lost?' } });
    const key = onlyDraftKey();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));

    act(() => {
      notifyComposerBusyFailure();
    });

    // The draft hook never restores text itself; the harness runtime used here has no restore
    // of its own (the real one is `onPreTurnFailure` in `@truefoundry/assistant-ui-runtime`), so
    // the composer stays empty. The stored draft is still held.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(input.value).toBe('');
    expect(window.sessionStorage.getItem(key)).toBe('lost?');

    // A reload -- a fresh mount reading the same key -- gets the text back.
    view.unmount();
    renderComposer(onNew);
    const reloadedInput = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    await waitFor(() => expect(reloadedInput.value).toBe('lost?'));
  });

  it('empties the composer after a slow-starting turn finishes', async () => {
    const onNew = vi.fn(async () => {});
    const view = render(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'slow model, please' } });
    const key = onlyDraftKey();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input.value).toBe(''));
    // Many seconds pass with no stream event yet: nothing has changed, the draft is still held.
    expect(window.sessionStorage.getItem(key)).toBe('slow model, please');

    // The turn finally starts.
    view.rerender(
      <RuntimeHarness messages={[]} isRunning onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());

    // The turn finishes.
    view.rerender(
      <RuntimeHarness messages={[{ role: 'assistant', content: 'done' }]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(input.value).toBe('');
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it('empties the composer once the reply arrives, even if the running flag never flips', async () => {
    // The "turn is running" signal can lag or, for some backends, never surface at all; the
    // reply actually landing in the thread must be enough on its own to drop the draft.
    const onNew = vi.fn(async () => {});
    const view = render(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'no running flag here' } });
    const key = onlyDraftKey();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));
    expect(window.sessionStorage.getItem(key)).toBe('no running flag here');

    // The reply shows up, but `isRunning` is never set for this thread.
    view.rerender(
      <RuntimeHarness messages={[{ role: 'assistant', content: 'done' }]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );

    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    expect(input.value).toBe('');
  });

  it('never puts a sent message back after the turn finishes', async () => {
    const onNew = vi.fn(async () => {});
    const view = render(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'Now reply with exactly the word mango.' } });
    const key = onlyDraftKey();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));

    // The turn starts: the sent message and an optimistic assistant reply show up in the thread.
    view.rerender(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'Now reply with exactly the word mango.' },
          { role: 'assistant', content: '' },
        ]}
        isRunning
        onNew={onNew}
      >
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());

    // The turn finishes with the real reply.
    view.rerender(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'Now reply with exactly the word mango.' },
          { role: 'assistant', content: 'mango' },
        ]}
        onNew={onNew}
      >
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(input.value).toBe('');
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it('never puts a sent message back when the running flag was never observed', async () => {
    const onNew = vi.fn(async () => {});
    const view = render(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'no running flag observed' } });
    const key = onlyDraftKey();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));

    // Straight to the finished state, with the running flag never having flipped: the thread
    // count growing past the count seen at send is enough on its own.
    view.rerender(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'no running flag observed' },
          { role: 'assistant', content: 'done' },
        ]}
        onNew={onNew}
      >
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );

    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    expect(input.value).toBe('');
  });

  it('keeps saving text the runtime gives back after a failed send', async () => {
    const onNew = vi.fn(async () => {});
    render(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <RestoreTextButton text="lost?" />
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'lost?' } });
    const key = onlyDraftKey();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));

    act(() => {
      notifyComposerBusyFailure();
    });

    // The chat runtime, not the draft hook, puts the text back.
    fireEvent.click(screen.getByRole('button', { name: 'restore' }));
    await waitFor(() => expect(input.value).toBe('lost?'));
    expect(window.sessionStorage.getItem(key)).toBe('lost?');

    // The hook sees this as ordinary typing and keeps saving it.
    fireEvent.change(input, { target: { value: 'lost?, edited' } });
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBe('lost?, edited'));
  });

  it('a second send after a completed turn sends only the new text', async () => {
    const onNew = vi.fn<(message: AppendMessage) => Promise<void>>(async () => {});
    const view = render(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'first' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));

    view.rerender(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'first' },
          { role: 'assistant', content: '' },
        ]}
        isRunning
        onNew={onNew}
      >
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument());

    view.rerender(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
        ]}
        onNew={onNew}
      >
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: 'second' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(2));

    const secondCall = onNew.mock.calls[1]?.[0];
    expect(secondCall?.content).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('keeps drafts apart per account and never copies text across a switch', async () => {
    const view = render(
      <ComposerDraftScopeProvider scope="alice@example.com">
        <RuntimeHarness messages={[]}>
          <ComposerBusyProvider>
            <ComposerContainer />
          </ComposerBusyProvider>
        </RuntimeHarness>
      </ComposerDraftScopeProvider>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'for alice' } });
    const aliceKey = onlyDraftKey();
    expect(aliceKey).toContain(encodeURIComponent('alice@example.com'));

    view.rerender(
      <ComposerDraftScopeProvider scope="bob@example.com">
        <RuntimeHarness messages={[]}>
          <ComposerBusyProvider>
            <ComposerContainer />
          </ComposerBusyProvider>
        </RuntimeHarness>
      </ComposerDraftScopeProvider>,
    );
    await waitFor(() => expect(input.value).toBe('for alice'));
    expect(window.sessionStorage.getItem(aliceKey)).toBe('for alice');
    expect(draftKeys()).toEqual([aliceKey]);

    fireEvent.change(input, { target: { value: 'for bob' } });
    const bobKey = draftKeys().find(key => key !== aliceKey);
    expect(bobKey).toContain(encodeURIComponent('bob@example.com'));
    expect(window.sessionStorage.getItem(aliceKey)).toBe('for alice');
    expect(window.sessionStorage.getItem(bobKey ?? '')).toBe('for bob');
  });

  it('leaves a saved draft alone when the composer mounts empty and nothing is typed', async () => {
    const key = await draftKeyOf(renderComposer);
    window.sessionStorage.setItem(key, '');
    renderComposer();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(window.sessionStorage.getItem(key)).toBe('');
  });

  it('moves a draft stored under the local id when the composer mounts on the server id', async () => {
    const localId = 'local-conversation-1';
    const remoteId = 'server-conversation-1';
    const localKey = composerDraftKey({ scope: '', thread: localId });
    window.sessionStorage.setItem(localKey, 'moved along with the rename');

    render(
      <RuntimeHarness messages={[]} threadId={localId} remoteId={remoteId}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    await waitFor(() => expect(input.value).toBe('moved along with the rename'));

    const remoteKey = composerDraftKey({ scope: '', thread: remoteId });
    expect(window.sessionStorage.getItem(remoteKey)).toBe('moved along with the rename');
    expect(window.sessionStorage.getItem(localKey)).toBeNull();
  });

  it('does not put the message back when the composer remounts in the middle of a send', async () => {
    // The composer remounts when the welcome view becomes a thread on the first message. The
    // stored draft is the message on its way, not something for the new instance to restore.
    const onNew = vi.fn<(message: AppendMessage) => Promise<void>>(async () => {});
    const view = render(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer key="welcome" />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'first message' } });
    const key = onlyDraftKey();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input.value).toBe(''));

    // Remount while the send is still in flight and nothing has been accepted yet.
    view.rerender(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer key="thread" />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const remounted = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(remounted.value).toBe('');
    expect(window.sessionStorage.getItem(key)).toBe('first message');

    // The turn runs and finishes: the draft is retired and the box stays empty.
    view.rerender(
      <RuntimeHarness messages={[{ role: 'user', content: 'first message' }]} isRunning onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer key="thread" />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    view.rerender(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'first message' },
          { role: 'assistant', content: 'reply' },
        ]}
        onNew={onNew}
      >
        <ComposerBusyProvider>
          <ComposerContainer key="thread" />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(remounted.value).toBe('');
  });

  it("restores another conversation's saved draft while a send is pending elsewhere", async () => {
    const onNew = vi.fn<(message: AppendMessage) => Promise<void>>(async () => {});
    const view = render(
      <RuntimeHarness messages={[]} threadId="conversation-a" onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'sending on a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input.value).toBe(''));
    // The harness's isRunning never flips true for conversation-a, so isSubmitting stays true.

    window.sessionStorage.setItem(composerDraftKey({ scope: '', thread: 'conversation-b' }), 'draft for b');

    // Switch to another conversation with the send on conversation-a still pending, keeping the
    // same ComposerBusyProvider instance.
    view.rerender(
      <RuntimeHarness messages={[]} threadId="conversation-b" onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );

    await waitFor(() => expect(input.value).toBe('draft for b'));
  });

  it('drops a stored draft on mount when the thread already holds that message', async () => {
    const key = await draftKeyOf(renderComposer);
    window.sessionStorage.setItem(key, 'already delivered');

    render(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'already delivered' },
          { role: 'assistant', content: 'reply' },
        ]}
      >
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(input.value).toBe('');
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it('keeps a retyped draft that repeats an older message', async () => {
    const key = await draftKeyOf(renderComposer);
    window.sessionStorage.setItem(key, 'hello');

    render(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'more' },
          { role: 'assistant', content: 'ok' },
        ]}
      >
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });

    // Only the most recent user message decides delivery, and it reads 'more', not 'hello': the
    // stored draft is a retyped message, not something already sent, so it is put back.
    await waitFor(() => expect(input.value).toBe('hello'));
    expect(window.sessionStorage.getItem(key)).toBe('hello');
  });

  it('waits for history before deciding a stored draft was delivered', async () => {
    const key = await draftKeyOf(renderComposer);
    window.sessionStorage.setItem(key, 'still loading');

    const view = render(
      <RuntimeHarness messages={[]} isLoading>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });

    // While history is still hydrating, nothing is decided: the draft is neither restored nor
    // cleared.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(input.value).toBe('');
    expect(window.sessionStorage.getItem(key)).toBe('still loading');

    // History finishes loading and already shows the stored text as a delivered user message.
    view.rerender(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'still loading' },
          { role: 'assistant', content: 'reply' },
        ]}
      >
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );

    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    expect(input.value).toBe('');
  });

  it('clears the stored draft even when the reply is already in the thread by the first empty render', async () => {
    const onNew = vi.fn(async () => {});
    const view = render(
      <RuntimeHarness messages={[]} onNew={onNew}>
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'faster than the empty render' } });
    const key = onlyDraftKey();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));

    // One rerender straight to the finished state: no intermediate render observed the composer
    // empty with the thread not yet grown.
    view.rerender(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'faster than the empty render' },
          { role: 'assistant', content: 'done' },
        ]}
        onNew={onNew}
      >
        <ComposerBusyProvider>
          <ComposerContainer />
        </ComposerBusyProvider>
      </RuntimeHarness>,
    );

    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    expect(input.value).toBe('');
  });

  it('wraps the composer in an attachment dropzone by default', () => {
    renderComposer();
    const dropzone = document.querySelector('[data-slot="aui_composer-attachment-dropzone"]');
    expect(dropzone).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeInTheDocument();
  });

  it('marks the dropzone as dragging on drag enter', () => {
    renderComposer();
    const dropzone = document.querySelector('[data-slot="aui_composer-attachment-dropzone"]');
    expect(dropzone).not.toBeNull();
    if (dropzone === null) {
      throw new Error('Expected attachment dropzone');
    }
    fireEvent.dragEnter(dropzone);
    expect(dropzone).toHaveAttribute('data-dragging', 'true');
  });

  it('keeps the caret in place when text is inserted mid-string', () => {
    renderComposer();
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });

    fireEvent.change(input, { target: { value: 'hello world' } });
    fireEvent.change(input, {
      target: { value: 'hello Xworld', selectionStart: 7, selectionEnd: 7 },
    });

    expect(input.value).toBe('hello Xworld');
    expect(input.selectionStart).toBe(7);
  });

  it('submits once on Enter and inserts a newline on Shift+Enter', async () => {
    const onNew = vi.fn(async () => {});
    renderComposer(onNew);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });

    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onNew).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('disables send when no model is selected in mutable draft', async () => {
    agentSpecState.agentSpec = { model: { name: '' } };
    const onNew = vi.fn(async () => {});
    // No ShellModeProvider → treated as requiring a client-side model (draft path).
    renderComposer(onNew);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });

    fireEvent.change(input, { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe('hi'));
    expect(onNew).not.toHaveBeenCalled();
  });

  it('allows send on named agents without a client-side model', async () => {
    agentSpecState.agentSpec = undefined;
    const onNew = vi.fn(async () => {});
    render(
      <ShellModeProvider agentConfig={{ mode: 'SingleAgent', name: 'support' }}>
        <RuntimeHarness messages={[]} onNew={onNew}>
          <ComposerBusyProvider>
            <ComposerContainer />
          </ComposerBusyProvider>
        </RuntimeHarness>
      </ShellModeProvider>,
    );
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });

    fireEvent.change(input, { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('preserves consumer section overrides in draft mode', () => {
    render(
      <SlotsProvider
        overrides={{
          ComposerLeftSection: () => <div>Custom left</div>,
          ComposerRightSection: () => <div>Custom right</div>,
        }}
      >
        <ShellModeProvider
          agentConfig={{
            mode: 'AgentComposer',
            defaultAgentSpec: { model: { name: 'test/model' } },
          }}
        >
          <RuntimeHarness messages={[]}>
            <ComposerBusyProvider>
              <ComposerContainer />
            </ComposerBusyProvider>
          </RuntimeHarness>
        </ShellModeProvider>
      </SlotsProvider>,
    );

    expect(screen.getByText('Custom left')).toBeInTheDocument();
    expect(screen.getByText('Custom right')).toBeInTheDocument();
  });

  it('mounts a registered custom action renderer instead of the composer', () => {
    toolResponsesState.pending = [{ toolCallId: 'tc-1', toolName: 'secret_select', args: { secrets: ['a'] } }];

    render(
      <CustomActionRenderersProvider renderers={{ secret_select: SecretSelectProbe }}>
        <RuntimeHarness messages={[]}>
          <ComposerBusyProvider>
            <ComposerContainer />
          </ComposerBusyProvider>
        </RuntimeHarness>
      </CustomActionRenderersProvider>,
    );

    expect(screen.getByRole('button', { name: 'Secret selector' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message input' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Secret selector' }));
    expect(toolResponsesState.respond).toHaveBeenCalledWith({
      toolCallId: 'tc-1',
      content: 'chosen-secret',
    });
  });

  it('shows the approval banner above a disabled composer while approvals are pending', () => {
    approvalsState.pending = [
      {
        approvalId: 'appr-1',
        threadId: 'root',
        toolName: 'call_tool',
        args: {},
        argsText: '{}',
      },
      {
        approvalId: 'appr-2',
        threadId: 'root',
        toolName: 'call_tool',
        args: {},
        argsText: '{}',
      },
    ];

    // Pending approvals are answerable only when they sit on the newest message.
    renderComposer(undefined, [
      {
        role: 'assistant',
        content: approvalsState.pending.map(item => ({
          type: 'tool-call' as const,
          toolCallId: item.approvalId,
          toolName: item.toolName,
          args: {},
          approval: { id: item.approvalId, approved: undefined },
        })),
      },
    ]);

    expect(screen.getByText('2 tools need your input')).toBeInTheDocument();
    expect(screen.getByText('(1/2)')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeDisabled();
    expect(document.querySelector('[data-slot="aui_composer-approval-pause"]')).toBeInTheDocument();
  });

  it('surfaces cancellation failures instead of silently clearing the running state', async () => {
    let resolvePendingSubmit: (() => void) | undefined;
    const pendingSubmit = new Promise<void>(resolve => {
      resolvePendingSubmit = resolve;
    });
    cancelRun.mockRejectedValueOnce(new Error('cancel request failed'));
    render(
      <ToasterProvider>
        <RuntimeHarness messages={[]} onNew={() => pendingSubmit}>
          <ComposerBusyProvider>
            <ComposerContainer />
          </ComposerBusyProvider>
        </RuntimeHarness>
      </ToasterProvider>,
    );

    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    fireEvent.change(input, { target: { value: 'start a turn' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(cancelRun).toHaveBeenCalledOnce());
    expect(await screen.findByText('cancel request failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    resolvePendingSubmit?.();
  });

  it('shows the model and capabilities selectors in a plain New Chat composer', async () => {
    const server = createMockAgentUIServer({
      getModels: async () => [
        {
          id: 'gpt-4.1',
          name: 'openai/gpt-4.1',
          provider: { name: 'OpenAI' },
          properties: { reasoningEfforts: ['low', 'high'] },
        },
      ],
    });

    render(
      <ServerProvider server={server}>
        <ShellModeProvider agentConfig={{ mode: 'AgentComposer', defaultAgentSpec: { model: { name: 'test/model' } } }}>
          <RuntimeHarness messages={[]}>
            <ComposerBusyProvider>
              <ComposerContainer />
            </ComposerBusyProvider>
          </RuntimeHarness>
        </ShellModeProvider>
      </ServerProvider>,
    );

    // A plain New Chat (mutable, not the agent builder) must still show the capabilities picker
    // (connectors / skills / sandbox) and the model picker in the composer.
    expect(screen.getByRole('button', { name: /Add-ons/ })).toBeInTheDocument();
    expect(await screen.findByTitle('Select model')).toBeInTheDocument();
  });
});

function voiceInput(availability: VoiceAvailability): VoiceInputApi {
  return {
    subscribeAvailability: listener => {
      listener(availability);
      return () => {};
    },
    transcribe: async () => ({ text: '', language: 'en', duration_ms: 0, model: 'test' }),
  };
}

function renderShellComposer({ agentConfig, voice }: { agentConfig: AgentConfig; voice: VoiceInputApi }) {
  const server = createMockAgentUIServer({
    getModels: async () => [
      {
        id: 'gpt-4.1',
        name: 'openai/gpt-4.1',
        provider: { name: 'OpenAI' },
        properties: { reasoningEfforts: ['low', 'high'] },
      },
    ],
  });

  return render(
    <ServerProvider server={server}>
      <VoiceInputProvider api={voice}>
        <ShellModeProvider agentConfig={agentConfig}>
          <RuntimeHarness messages={[]}>
            <ComposerBusyProvider>
              <ComposerContainer />
            </ComposerBusyProvider>
          </RuntimeHarness>
        </ShellModeProvider>
      </VoiceInputProvider>
    </ServerProvider>,
  );
}

describe('ComposerContainer voice input', () => {
  const MIC = { name: 'Record voice message' };
  const draftConfig: AgentConfig = {
    mode: 'AgentLibraryWithComposer',
    defaultAgentSpec: { model: { name: 'test/model' } },
  };

  beforeEach(() => {
    agentSpecState.agentSpec = { model: { name: 'test/model' } };
    voiceCapture.supported = true;
    window.sessionStorage.clear();
  });

  it('shows the mic between the model selector and Send in the draft composer', async () => {
    renderShellComposer({ agentConfig: draftConfig, voice: voiceInput(true) });

    const mic = await screen.findByRole('button', MIC);
    const modelSelector = await screen.findByTitle('Select model');
    const send = screen.getByRole('button', { name: 'Send message' });
    const buttons = screen.getAllByRole('button');

    expect(buttons.indexOf(modelSelector)).toBeGreaterThanOrEqual(0);
    expect(buttons.indexOf(mic)).toBeGreaterThan(buttons.indexOf(modelSelector));
    expect(buttons.indexOf(send)).toBeGreaterThan(buttons.indexOf(mic));
  });

  it('hides the mic in the draft composer while voice is unavailable', async () => {
    renderShellComposer({ agentConfig: draftConfig, voice: voiceInput(false) });

    expect(await screen.findByTitle('Select model')).toBeInTheDocument();
    expect(screen.queryByRole('button', MIC)).not.toBeInTheDocument();
  });

  it('hides the mic in the draft composer when the browser cannot capture audio', async () => {
    voiceCapture.supported = false;
    renderShellComposer({ agentConfig: draftConfig, voice: voiceInput(true) });

    expect(await screen.findByTitle('Select model')).toBeInTheDocument();
    expect(screen.queryByRole('button', MIC)).not.toBeInTheDocument();
  });

  it('keeps the mic beside Send for a named agent', async () => {
    renderShellComposer({ agentConfig: { mode: 'SingleAgent', name: 'support' }, voice: voiceInput(true) });

    expect(await screen.findByRole('button', MIC)).toBeInTheDocument();
    expect(screen.queryByTitle('Select model')).not.toBeInTheDocument();
  });
});
