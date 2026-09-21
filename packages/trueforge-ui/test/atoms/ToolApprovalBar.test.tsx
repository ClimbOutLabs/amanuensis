// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ToolApprovalBar, type ApprovalOption } from '@/atoms/ToolApprovalBar.js';

const reasonOption: ApprovalOption = {
  id: 'deny-with-reason',
  label: 'Deny',
  requiresReason: true,
  grants: ['filesystem:read'],
  confirm: {
    title: 'Explain the denial',
    description: 'The agent will receive this reason.',
  },
};

describe('ToolApprovalBar', () => {
  it('renders optional admission guidance without changing the public decisions', () => {
    render(
      <ToolApprovalBar
        toolName="apply_patch"
        guidance="Allow once still works outside an active plan."
        approveOptions={[
          { id: 'allow-once', label: 'Allow once' },
          { id: 'allow-chat', label: 'Allow in this chat' },
        ]}
        denyOptions={[{ id: 'deny', label: 'Deny' }]}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText('Allow once still works outside an active plan.')).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map(option => option.getAttribute('value'))).toEqual([
      'allow-once',
      'allow-chat',
      'deny',
    ]);
  });

  it('shows host-observed edit context only while an approval is pending', () => {
    const summary = 'src/app.ts present, 42 bytes, sha256 abcdef123456';
    const { rerender } = render(
      <ToolApprovalBar toolName="replace_text" hostObservedTargetSummary={summary} onSelect={() => {}} />,
    );

    expect(screen.getByTestId('host-observed-target')).toHaveTextContent(summary);

    rerender(
      <ToolApprovalBar
        toolName="replace_text"
        hostObservedTargetSummary={summary}
        onSelect={() => {}}
        status={{ type: 'denied', label: 'Blocked: target changed' }}
      />,
    );
    expect(screen.queryByTestId('host-observed-target')).not.toBeInTheDocument();
    expect(screen.getAllByText('Blocked: target changed')).toHaveLength(2);
  });

  it('submits immediate approve and deny options', () => {
    const onSelect = vi.fn();
    render(
      <ToolApprovalBar
        toolName="shell"
        approveOptions={[{ id: 'allow-once', label: 'Allow once', variant: 'primary' }]}
        denyOptions={[{ id: 'reject', label: 'Reject', variant: 'destructive' }]}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole('radiogroup', { name: 'Approval options for shell' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Allow once' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Reject' }));
    expect(onSelect).toHaveBeenNthCalledWith(1, 'allow-once');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'reject');
  });

  it('drives the controlled denial-reason workflow and error state', () => {
    const onDenyOptionChange = vi.fn();
    const onDenialReasonChange = vi.fn();
    const onReasonSubmit = vi.fn();
    const { rerender } = render(
      <ToolApprovalBar
        toolName="filesystem"
        denyOptions={[reasonOption]}
        onSelect={() => {}}
        onDenyOptionChange={onDenyOptionChange}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Deny' }));
    expect(onDenyOptionChange).toHaveBeenCalledWith('deny-with-reason');

    rerender(
      <ToolApprovalBar
        toolName="filesystem"
        denyOptions={[reasonOption]}
        selectedDenyOption={reasonOption}
        denialReason="unsafe"
        showReasonError
        onSelect={() => {}}
        onDenyOptionChange={onDenyOptionChange}
        onDenialReasonChange={onDenialReasonChange}
        onReasonSubmit={onReasonSubmit}
      />,
    );

    expect(screen.getByText('Explain the denial')).toBeInTheDocument();
    expect(screen.getByText('filesystem:read')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Reason is required');
    const reasonInput = screen.getByRole('textbox', { name: 'Reason for denial' });
    expect(reasonInput).toHaveAttribute('aria-invalid', 'true');
    expect(reasonInput).toHaveClass('h-8');
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveClass('h-6');

    fireEvent.change(reasonInput, { target: { value: 'new reason' } });
    expect(onDenialReasonChange).toHaveBeenCalledWith('new reason');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onReasonSubmit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onDenyOptionChange).toHaveBeenLastCalledWith(null);
  });

  it('locks disabled interactions and hides controls in read-only mode', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<ToolApprovalBar toolName="shell" onSelect={onSelect} disabled />);

    expect(screen.getByRole('radio', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Deny' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    expect(onSelect).not.toHaveBeenCalled();

    rerender(<ToolApprovalBar toolName="shell" onSelect={onSelect} readOnly />);
    expect(screen.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Deny' })).not.toBeInTheDocument();
    expect(screen.getByText('Tool Approval Required for')).toBeInTheDocument();
    expect(screen.getByText('Awaiting decision')).toBeInTheDocument();
  });

  it('renders approved and denied decisions with an optional reason', () => {
    const { rerender } = render(
      <ToolApprovalBar toolName="shell" onSelect={() => {}} status={{ type: 'approved' }} dataTestPrefix="tool" />,
    );
    expect(screen.getByText('Tool Approved')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();

    rerender(
      <ToolApprovalBar
        toolName="shell"
        onSelect={() => {}}
        status={{ type: 'denied', reason: 'Policy blocked it' }}
        dataTestPrefix="tool"
      />,
    );
    expect(screen.getByText('Tool Approval Denied')).toBeInTheDocument();
    expect(screen.getByText('Reason: Policy blocked it')).toBeInTheDocument();
  });
});
