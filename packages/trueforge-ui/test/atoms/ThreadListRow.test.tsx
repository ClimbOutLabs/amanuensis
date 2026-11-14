// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ThreadListRow } from '@/atoms/ThreadListRow.js';
import { DropdownMenuItem } from '@/atoms/primitives/DropdownMenu.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';

describe('ThreadListRow', () => {
  it('hides actions when omitted', () => {
    render(
      <SlotsProvider>
        <ThreadListRow title="Session A" active={false} onSelect={() => {}} />
      </SlotsProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Session actions' })).not.toBeInTheDocument();
  });

  it('renders actions without selecting the row when the action is clicked', () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(
      <SlotsProvider>
        <ThreadListRow
          title="Session A"
          active={false}
          onSelect={onSelect}
          actions={<DropdownMenuItem onClick={onDelete}>Delete</DropdownMenuItem>}
        />
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('applies hover/active chrome on the row group so actions share the highlight', () => {
    const { container, rerender } = render(
      <SlotsProvider>
        <ThreadListRow title="Session A" active={false} onSelect={() => {}} />
      </SlotsProvider>,
    );
    const row = container.querySelector('[data-slot="aui_thread-list-item"]');
    expect(row?.className).toMatch(/hover:bg-ghost-button-hover/);
    expect(row?.className).not.toMatch(/bg-dropdown-selected-item-bg/);

    rerender(
      <SlotsProvider>
        <ThreadListRow title="Session A" active onSelect={() => {}} />
      </SlotsProvider>,
    );
    const activeRow = container.querySelector('[data-slot="aui_thread-list-item"]');
    expect(activeRow?.className).toMatch(/bg-dropdown-selected-item-bg/);
  });

  it('shows the dot and a bold title for a chat with something new', () => {
    const { container } = render(
      <SlotsProvider>
        <ThreadListRow title="Session A" active={false} onSelect={() => {}} unread />
      </SlotsProvider>,
    );
    expect(screen.getByRole('img', { name: 'New in this chat' })).toBeInTheDocument();
    expect(screen.getByText('Session A').className).toMatch(/font-semibold/);
    const row = container.querySelector('[data-slot="aui_thread-list-item"]');
    expect(row?.getAttribute('data-unread')).toBe('true');
  });

  it('shows no dot for a chat with nothing new', () => {
    const { container } = render(
      <SlotsProvider>
        <ThreadListRow title="Session A" active={false} onSelect={() => {}} />
      </SlotsProvider>,
    );
    expect(screen.queryByRole('img', { name: 'New in this chat' })).not.toBeInTheDocument();
    expect(screen.getByText('Session A').className).toMatch(/font-normal/);
    const row = container.querySelector('[data-slot="aui_thread-list-item"]');
    expect(row?.getAttribute('data-unread')).toBeNull();
  });

  it('renders agent name and relative time when provided', () => {
    const lastMessageAt = new Date(Date.now() - 30 * 60_000);
    render(
      <SlotsProvider>
        <ThreadListRow
          title="Hello chat"
          active={false}
          onSelect={() => {}}
          agentName="from-sdk"
          lastMessageAt={lastMessageAt}
        />
      </SlotsProvider>,
    );
    expect(screen.getByText('Hello chat')).toBeInTheDocument();
    const agentLine = screen.getByText('from-sdk').parentElement;
    expect(agentLine).toHaveClass('text-xs');
    expect(agentLine?.className).not.toMatch(/text-\[0\.75rem\]/);
    expect(screen.getByText('30m')).toBeInTheDocument();
  });

  it('keeps relative time and actions in one trailing slot that swaps on hover', () => {
    const lastMessageAt = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    const { container } = render(
      <SlotsProvider>
        <ThreadListRow
          title="Hello"
          active={false}
          onSelect={() => {}}
          agentName="test-gv-yo"
          lastMessageAt={lastMessageAt}
          actions={
            <button type="button" aria-label="Session actions">
              …
            </button>
          }
        />
      </SlotsProvider>,
    );
    const row = container.querySelector('[data-slot="aui_thread-list-item"]');
    expect(row?.className).toMatch(/items-center/);
    const time = screen.getByText('2d');
    expect(time.getAttribute('data-slot')).toBe('aui_thread-list-item-age');
    const actionsSlot = screen.getByRole('button', { name: 'Session actions' }).parentElement;
    expect(actionsSlot?.getAttribute('data-slot')).toBe('aui_thread-list-item-actions');
    expect(actionsSlot?.className).toMatch(/absolute/);
    expect(actionsSlot?.className).toMatch(/md:opacity-0/);
    expect(actionsSlot?.className).toMatch(/md:group-hover:opacity-100/);
    expect(time.className).toMatch(/md:opacity-100/);
    expect(time.className).toMatch(/md:group-hover:opacity-0/);
  });
});
