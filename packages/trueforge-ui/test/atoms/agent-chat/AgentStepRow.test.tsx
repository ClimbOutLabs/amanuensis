import { fireEvent, render, screen } from '@testing-library/react';
import type { SVGProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AgentStepRow, type AgentStepRowProps } from '@/atoms/agent-chat/AgentStepRow.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';
import type { ThemeConfig } from '@/theme/types.js';

function StepIconProbe(props: SVGProps<SVGSVGElement>) {
  return <svg {...props} data-testid="configured-step-icon" />;
}

const testTheme: ThemeConfig = {
  mode: 'light',
  icons: {
    'test-step': StepIconProbe,
  },
};

function TestSubject(props: Omit<AgentStepRowProps, 'icon'>) {
  return (
    <ThemeProvider theme={testTheme}>
      <AgentStepRow icon="test-step" {...props} />
    </ThemeProvider>
  );
}

describe('AgentStepRow', () => {
  it('sizes the title on the --text-xs scale step, not a one-off literal', () => {
    render(<TestSubject title="Fetch deployment" dataTestPrefix="fetch" />);

    const title = screen.getByTestId('fetch-title');
    expect(title).toHaveClass('text-xs');
    expect(title.className).not.toMatch(/text-\[0\.75rem\]/);
  });

  it('exposes its controlled expansion and propagates only intended row clicks', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <TestSubject
        title="Fetch deployment"
        body={<button type="button">Inspect response</button>}
        expandable
        expanded={false}
        onToggle={onToggle}
        dataTestPrefix="fetch"
      />,
    );

    expect(screen.getByTestId('configured-step-icon')).toHaveAttribute('aria-hidden', 'true');

    const expandButton = screen.getByRole('button', { name: 'Expand step' });
    expect(expandButton).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(expandButton);
    fireEvent.click(screen.getByTestId('fetch-title'));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect response' }));
    expect(onToggle).toHaveBeenCalledTimes(3);

    rerender(
      <TestSubject
        title="Fetch deployment"
        body={<button type="button">Inspect response</button>}
        expandable
        expanded
        onToggle={onToggle}
        dataTestPrefix="fetch"
      />,
    );

    const collapseButton = screen.getByRole('button', { name: 'Collapse step' });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Inspect response' }));
    expect(onToggle).toHaveBeenCalledTimes(3);

    fireEvent.click(collapseButton);
    expect(onToggle).toHaveBeenCalledTimes(4);
  });

  it('hides collapsible children while keeping persistent children mounted', () => {
    const { rerender } = render(
      <TestSubject
        title="Process files"
        expanded={false}
        dataTestPrefix="process"
        showPersistentContentConnector={false}
        persistentChildren={<div>Always-visible progress</div>}
      >
        <div>Expanded details</div>
      </TestSubject>,
    );

    expect(screen.queryByTestId('process-expanded-content')).not.toBeInTheDocument();
    expect(screen.queryByText('Expanded details')).not.toBeInTheDocument();
    expect(screen.getByTestId('process-persistent-content')).toHaveTextContent('Always-visible progress');
    expect(screen.getByTestId('process-persistent-content')).toHaveClass('gap-2');

    rerender(
      <TestSubject
        title="Process files"
        expanded
        dataTestPrefix="process"
        showPersistentContentConnector={false}
        persistentChildren={<div>Always-visible progress</div>}
      >
        <div>Expanded details</div>
      </TestSubject>,
    );

    expect(screen.getByTestId('process-expanded-content')).toHaveTextContent('Expanded details');
    expect(screen.getByTestId('process-persistent-content')).toHaveTextContent('Always-visible progress');
  });

  it('presents running, success, and error statuses with their intended indicators', () => {
    const { rerender } = render(
      <TestSubject title="Run command" status="running" statusText="Running" dataTestPrefix="command" />,
    );

    const runningText = screen.getByText('Running');
    expect(runningText.previousElementSibling).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();

    rerender(<TestSubject title="Run command" status="running" showSpinner dataTestPrefix="command" />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();

    rerender(<TestSubject title="Run command" status="success" dataTestPrefix="command" />);
    expect(screen.getByTestId('command-success-icon')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('command-error-icon')).not.toBeInTheDocument();

    rerender(<TestSubject title="Run command" status="error" dataTestPrefix="command" />);
    expect(screen.getByTestId('command-error-icon')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByTestId('command-success-icon')).not.toBeInTheDocument();
  });

  it('wraps a long error message instead of overflowing the row', () => {
    const longError =
      "Execution failed: call_tool rejected the tool_name: received 'list_tools'; expected the name of a tool on 'tavily'. 'list_tools' is a reserved meta-tool name and cannot be dispatched directly through this MCP server.";

    render(<TestSubject title="tavily" status="error" statusText={longError} dataTestPrefix="tavily" />);

    const statusTextEl = screen.getByTestId('tavily-status-text');
    expect(statusTextEl).toHaveTextContent(longError);
    expect(statusTextEl).toHaveClass('whitespace-normal');
    expect(statusTextEl).toHaveClass('break-words');
    expect(statusTextEl).toHaveClass('min-w-0');
    expect(statusTextEl.closest('div')).not.toHaveClass('shrink-0');
  });
});
