// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentSessionTurnHeader } from '@/atoms/agent-details/AgentSessionTurnHeader.js';

describe('AgentSessionTurnHeader', () => {
  it('shows an Input / Output / Cached tooltip on the turn token count', () => {
    render(
      <AgentSessionTurnHeader
        turnNumber={1}
        totalTokens={8063}
        inputTokens={8000}
        outputTokens={63}
        cachedTokens={0}
        durationMs={1200}
      />,
    );

    const tokens = screen.getByRole('button', { name: /Tokens 8K/i });
    fireEvent.mouseEnter(tokens);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Input');
    expect(screen.getByRole('tooltip')).toHaveTextContent('8K');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Output');
    expect(screen.getByRole('tooltip')).toHaveTextContent('63');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Cached');
    expect(screen.getByRole('tooltip')).toHaveTextContent('0');
  });

  it('exposes the breakdown on a focusable token control', () => {
    render(
      <AgentSessionTurnHeader
        turnNumber={1}
        totalTokens={9000}
        inputTokens={7000}
        outputTokens={1000}
        cachedTokens={1000}
      />,
    );

    const tokens = screen.getByRole('button', {
      name: 'Tokens 9K. Input 7K, Output 1K, Cached 1K',
    });
    fireEvent.focus(tokens);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('shows a where-the-time-went tooltip on the turn duration', () => {
    render(
      <AgentSessionTurnHeader
        turnNumber={1}
        durationMs={12000}
        timeBreakdown={[
          { label: 'model', value: 6000, color: '#3b82f6' },
          { label: 'tools', value: 4000, color: '#f59e0b' },
          { label: 'waiting on human', value: 1000, color: '#f472b6' },
          { label: 'overhead', value: 1000, color: '#94a3b8' },
        ]}
      />,
    );

    const duration = screen.getByRole('button', { name: /Duration 12\.00s/i });
    fireEvent.mouseEnter(duration);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Where the time went');
    expect(tooltip).toHaveTextContent('model');
    expect(tooltip).toHaveTextContent('tools');
    expect(tooltip).toHaveTextContent('waiting on human');
    expect(tooltip).toHaveTextContent('overhead');
  });

  it('renders duration without a tooltip when no breakdown is provided', () => {
    render(<AgentSessionTurnHeader turnNumber={1} durationMs={12000} />);

    const duration = screen.getByRole('button', { name: 'Duration 12.00s' });
    fireEvent.mouseEnter(duration);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
