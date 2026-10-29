// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TrueFoundryChatProvider } from '@/containers/TrueFoundryChatProvider.js';
import {
  ChatNoticeProvider,
  createChatNoticeChannel,
  useChatNotice,
  useSkillsNoticeReporter,
} from '@/hooks/useChatNotice.js';
import type { SkillsNotice } from '@/utils/turnRefusal.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

let report: (kind: SkillsNotice | null) => void = () => undefined;

function Probe() {
  report = useSkillsNoticeReporter();
  return <p data-testid="notice">{useChatNotice()?.kind ?? 'none'}</p>;
}

const channel = createChatNoticeChannel();

function renderProbe() {
  render(
    <TrueFoundryChatProvider server={createMockAgentUIServer({})} agentName="agent">
      <ChatNoticeProvider channel={channel}>
        <Probe />
      </ChatNoticeProvider>
    </TrueFoundryChatProvider>,
  );
}

describe('the skills notice', () => {
  it('shows while the sandbox is off and goes away once it is on', async () => {
    renderProbe();

    act(() => report('skills_off_without_sandbox'));
    expect((await screen.findByTestId('notice')).textContent).toBe('skills_off_without_sandbox');

    act(() => report(null));
    expect(screen.getByTestId('notice').textContent).toBe('none');
  });

  it('does not replace or take down a refused-send line', async () => {
    renderProbe();

    act(() => channel.report('turn_could_not_start'));
    act(() => report('skills_off_without_sandbox'));
    expect((await screen.findByTestId('notice')).textContent).toBe('turn_could_not_start');

    act(() => report(null));
    expect(screen.getByTestId('notice').textContent).toBe('turn_could_not_start');
  });
});
