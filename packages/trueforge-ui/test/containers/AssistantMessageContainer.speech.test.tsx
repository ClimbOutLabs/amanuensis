// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { stopSpeaking } from '@/utils/speechOutput.js';
import {
  installSpeechSynthesis,
  removeSpeechSynthesis,
  spokenTexts,
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
  },
];

function renderAnswer() {
  return render(
    <RuntimeHarness messages={answer} isRunning={false}>
      <ThreadPrimitive.Messages>
        {({ message }) => (message.role === 'assistant' ? <AssistantMessageContainer /> : null)}
      </ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
}

describe('finished answer read-aloud controls', () => {
  let synthesis: FakeSpeechSynthesis;

  beforeEach(() => {
    synthesis = installSpeechSynthesis();
  });

  afterEach(() => {
    stopSpeaking();
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
});
