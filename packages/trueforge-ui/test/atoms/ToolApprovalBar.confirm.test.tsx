// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ToolApprovalBar, type ApprovalOption } from '@/atoms/ToolApprovalBar.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const grantOption: ApprovalOption = {
  id: 'allow-chat',
  label: 'Approve for this chat',
  variant: 'primary',
  grants: ['filesystem:write', 'network:egress'],
};

const plainOption: ApprovalOption = { id: 'allow-once', label: 'Approve', variant: 'secondary' };

function renderBar(onSelect: (optionId: string) => void) {
  render(
    <ToolApprovalBar
      toolName="apply_patch"
      approveOptions={[plainOption, grantOption]}
      denyOptions={[{ id: 'deny', label: 'Deny' }]}
      onSelect={onSelect}
      dataTestPrefix="approval"
    />,
  );
}

describe('ToolApprovalBar grant confirmation', () => {
  it('opens the confirm dialog listing the grants instead of applying immediately', () => {
    const onSelect = vi.fn();
    renderBar(onSelect);

    fireEvent.click(screen.getByRole('radio', { name: 'Approve for this chat' }));

    expect(onSelect).not.toHaveBeenCalled();
    const dialog = screen.getByTestId('approval-grant-confirm-dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent('filesystem:write');
    expect(dialog).toHaveTextContent('network:egress');
  });

  it('dismisses the dialog with no side effect on Cancel', () => {
    const onSelect = vi.fn();
    renderBar(onSelect);

    fireEvent.click(screen.getByRole('radio', { name: 'Approve for this chat' }));
    fireEvent.click(screen.getByTestId('approval-grant-cancel'));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approval-grant-confirm-dialog')).not.toBeInTheDocument();
  });

  it('calls onSelect with the option id on Confirm', () => {
    const onSelect = vi.fn();
    renderBar(onSelect);

    fireEvent.click(screen.getByRole('radio', { name: 'Approve for this chat' }));
    fireEvent.click(screen.getByTestId('approval-grant-confirm'));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('allow-chat');
    expect(screen.queryByTestId('approval-grant-confirm-dialog')).not.toBeInTheDocument();
  });

  it('applies grant-less approve options immediately', () => {
    const onSelect = vi.fn();
    renderBar(onSelect);

    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('allow-once');
    expect(screen.queryByTestId('approval-grant-confirm-dialog')).not.toBeInTheDocument();
  });
});
