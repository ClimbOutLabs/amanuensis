// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentInternalsDisclosure } from '@/atoms/agent-chat/AgentInternalsDisclosure.js';

const PREFIX = 'test-internals';

function renderDisclosure(props: Partial<React.ComponentProps<typeof AgentInternalsDisclosure>> = {}) {
  return render(
    <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} {...props}>
      <div data-testid="trace-body">trace contents</div>
    </AgentInternalsDisclosure>,
  );
}

describe('AgentInternalsDisclosure', () => {
  it('renders the faint summary line collapsed by default', () => {
    renderDisclosure();

    const toggle = screen.getByTestId(`${PREFIX}-agent-internals-toggle`);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('3 steps · 2 tools · 6s');
    expect(screen.getByTestId('trace-body')).not.toBeVisible();
  });

  it('expands and collapses the trace on toggle', () => {
    renderDisclosure();

    const toggle = screen.getByTestId(`${PREFIX}-agent-internals-toggle`);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('trace-body')).toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('trace-body')).not.toBeVisible();
  });

  it('auto-expands on attention and collapses again when it clears', () => {
    const { rerender } = renderDisclosure({ attention: false });
    expect(screen.getByTestId(`${PREFIX}-agent-internals-toggle`)).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} attention>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    const toggle = screen.getByTestId(`${PREFIX}-agent-internals-toggle`);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId(`${PREFIX}-agent-internals-attention`)).toBeInTheDocument();

    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX}>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    expect(screen.getByTestId(`${PREFIX}-agent-internals-toggle`)).toHaveAttribute('aria-expanded', 'false');
  });

  it('re-expands when new attention arrives after a manual collapse', () => {
    const { rerender } = renderDisclosure({ attention: false });
    const toggle = screen.getByTestId(`${PREFIX}-agent-internals-toggle`);
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} attention>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    expect(screen.getByTestId(`${PREFIX}-agent-internals-toggle`)).toHaveAttribute('aria-expanded', 'true');
  });

  it('respects a manual collapse over later attention changes', () => {
    const { rerender } = renderDisclosure({ attention: true });
    const toggle = screen.getByTestId(`${PREFIX}-agent-internals-toggle`);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} attention>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    expect(screen.getByTestId(`${PREFIX}-agent-internals-toggle`)).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the live status label with a spinner while running', () => {
    renderDisclosure({ isRunning: true, liveLabel: 'Executing tools' });

    expect(screen.getByText(/Executing tools/)).toBeInTheDocument();
    expect(screen.getByTestId(`${PREFIX}-agent-internals-live-spinner`)).toBeInTheDocument();
  });

  it('collapses the live detail into the summary once the run completes', () => {
    const { rerender } = renderDisclosure({ isRunning: true, liveLabel: 'Executing tools' });
    expect(screen.getByText(/Executing tools/)).toBeInTheDocument();

    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX}>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    expect(screen.queryByText('Executing tools')).not.toBeInTheDocument();
    expect(screen.getByTestId(`${PREFIX}-agent-internals-toggle`)).toHaveTextContent('3 steps · 2 tools · 6s');
  });

  it('renders the preference toggle and forwards changes', () => {
    const onPreferenceChange = vi.fn();
    renderDisclosure({ defaultExpanded: true, showPreferenceToggle: true, preferenceOn: false, onPreferenceChange });

    const checkbox = screen.getByRole('checkbox', { name: 'Always show agent details' });
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    expect(onPreferenceChange).toHaveBeenCalledWith(true);
  });

  it('does not render the preference toggle by default', () => {
    renderDisclosure();
    expect(screen.queryByRole('checkbox', { name: 'Always show agent details' })).not.toBeInTheDocument();
  });

  it('follows defaultExpanded prop changes when the user has not toggled', () => {
    const { rerender } = renderDisclosure({ defaultExpanded: false });
    const toggle = screen.getByTestId(`${PREFIX}-agent-internals-toggle`);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} defaultExpanded>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} defaultExpanded={false}>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a manual collapse over later defaultExpanded changes', () => {
    const { rerender } = renderDisclosure({ defaultExpanded: true });
    const toggle = screen.getByTestId(`${PREFIX}-agent-internals-toggle`);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} defaultExpanded={false}>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    rerender(
      <AgentInternalsDisclosure summary="3 steps · 2 tools · 6s" dataTestPrefix={PREFIX} defaultExpanded>
        <div data-testid="trace-body">trace contents</div>
      </AgentInternalsDisclosure>,
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
