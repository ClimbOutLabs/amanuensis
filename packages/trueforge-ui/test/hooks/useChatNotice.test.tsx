// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TrueFoundryChatProvider } from '@/containers/TrueFoundryChatProvider.js';
import { useChatNotice, useSkillsNoticeReporter } from '@/hooks/useChatNotice.js';
import type { SkillsNotice } from '@/utils/turnRefusal.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

let report: (kind: SkillsNotice | null) => void = () => undefined;

function Probe() {
  report = useSkillsNoticeReporter();
  return <p data-testid="notice">{useChatNotice()?.kind ?? 'none'}</p>;
}

function renderProbe() {
  render(
    <TrueFoundryChatProvider server={createMockAgentUIServer({})} agentName="agent">
      <Probe />
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
});
