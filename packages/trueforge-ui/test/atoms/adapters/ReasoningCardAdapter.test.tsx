// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReasoningCard } from '@/atoms/adapters/ReasoningCardAdapter.js';

describe('ReasoningCard', () => {
  it('keeps completed raw reasoning out of the DOM', () => {
    const contentRef = vi.fn();
    render(
      <ReasoningCard
        content="SYSTEM PROMPT: use the absolute path C:\\Users\\owner\\Uploads\\secret.txt"
        expanded
        onToggle={() => {}}
        isMultiLine
        reasoningTimeText="Reasoned for 2s"
        previewText="Safe preview"
        contentRef={contentRef}
        dataTestPrefix="reason"
      />,
    );

    expect(screen.getByTestId('reason-reasoning')).toHaveAttribute('data-reasoning-redacted', 'true');
    expect(screen.getByTestId('reason-title')).toHaveTextContent('Reasoned for 2s');
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.queryByText(/SYSTEM PROMPT|Uploads|secret\.txt/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /step/i })).not.toBeInTheDocument();
    expect(contentRef).not.toHaveBeenCalled();
  });

  it('shows streaming progress without rendering the raw reasoning text', () => {
    render(
      <ReasoningCard
        content="Internal instructions and /Users/owner/uploads/private.txt"
        isStreaming
        headingText="Thinking through changes"
        dataTestPrefix="reason"
      />,
    );

    expect(screen.getByTestId('reason-title')).toHaveTextContent('Thinking through changes');
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.queryByText(/Internal instructions|private\.txt/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /step/i })).not.toBeInTheDocument();
  });
});
