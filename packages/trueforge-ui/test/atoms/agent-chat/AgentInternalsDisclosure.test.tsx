// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentInternalsDisclosure } from '@/atoms/agent-chat/AgentInternalsDisclosure.js';

const PREFIX = 'test-internals';

function renderDisclosure(props: Partial<React.ComponentProps<typeof AgentInternalsDisclosure>> = {}) {
  return render(
    <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} expanded={false} {...props}>
      <div data-testid="trace-body">trace contents</div>
    </AgentInternalsDisclosure>,
  );
}

describe('AgentInternalsDisclosure', () => {
  it('renders the faint summary line collapsed when the chat-level switch is off', () => {
    renderDisclosure();

    expect(screen.getByText('3 steps · 2 tools · 6s')).toBeInTheDocument();
    expect(screen.getByTestId('trace-body')).not.toBeVisible();
  });

  it('renders the trace expanded when the chat-level switch is on', () => {
    renderDisclosure({ expanded: true });

    expect(screen.getByTestId('trace-body')).toBeVisible();
  });

  it('has no per-turn expand control', () => {
    renderDisclosure();

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByTestId(`${PREFIX}-agent-internals-toggle`)).not.toBeInTheDocument();
  });

  it('auto-expands the trace for a running turn with attention, even with the switch off', () => {
    renderDisclosure({ expanded: false, attention: true, isRunning: true });

    expect(screen.getByTestId('trace-body')).toBeVisible();
    expect(screen.getByTestId(`${PREFIX}-agent-internals-attention`)).toBeInTheDocument();
  });

  it('keeps the trace collapsed for a completed turn with attention, switch off, but still shows the dot', () => {
    renderDisclosure({ expanded: false, attention: true });

    expect(screen.getByTestId('trace-body')).not.toBeVisible();
    expect(screen.getByTestId(`${PREFIX}-agent-internals-attention`)).toBeInTheDocument();
  });

  it('reveals a completed turn with attention when the chat-level switch is on', () => {
    renderDisclosure({ expanded: true, attention: true });

    expect(screen.getByTestId('trace-body')).toBeVisible();
    expect(screen.getByTestId(`${PREFIX}-agent-internals-attention`)).toBeInTheDocument();
  });

  it('renders the trace when lockOpen is set (pending approval), even with the switch off', () => {
    renderDisclosure({ expanded: false, lockOpen: true });

    expect(screen.getByTestId('trace-body')).toBeVisible();
  });

  it('shows the live status label with a spinner while running', () => {
    renderDisclosure({ isRunning: true, liveLabel: 'Executing tools' });

    expect(screen.getByText(/Executing tools/)).toBeInTheDocument();
    expect(screen.getByTestId(`${PREFIX}-agent-internals-live-spinner`)).toBeInTheDocument();
  });

  it('shows the plain summary once the run completes', () => {
    const { rerender } = renderDisclosure({ isRunning: true, liveLabel: 'Executing tools' });
    expect(screen.getByText(/Executing tools/)).toBeInTheDocument();

    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} expanded={false}>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    expect(screen.queryByText('Executing tools')).not.toBeInTheDocument();
    expect(screen.getByText('3 steps · 2 tools · 6s')).toBeInTheDocument();
  });
});
