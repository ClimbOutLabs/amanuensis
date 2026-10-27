import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ChatFolderSection } from '@/containers/ChatFolderControls.js';
import { FoldedChatGroup, type RecentChat } from '@/containers/RecentChatsGroups.js';

function renderRow(chat: RecentChat) {
  return (
    <div key={chat.key} role="listitem">
      chat {chat.key}
    </div>
  );
}

function rowTitles() {
  return screen.queryAllByRole('listitem').map(row => row.textContent);
}

const chats = (count: number): RecentChat[] =>
  Array.from({ length: count }, (_, index) => ({ key: String(index), time: 0, folderId: undefined }));

function renderGroup({
  label = 'Earlier',
  defaultOpen = false,
  count = 12,
  openKey,
}: { label?: string; defaultOpen?: boolean; count?: number; openKey?: string } = {}) {
  return render(
    <FoldedChatGroup
      section={label.toLowerCase()}
      label={label}
      defaultOpen={defaultOpen}
      chats={chats(count)}
      openKey={openKey}
      renderRow={renderRow}
    />,
  );
}

describe('FoldedChatGroup', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sizes the date-group heading on the --text-xs scale step, not a one-off literal', () => {
    renderGroup();

    const heading = screen.getByRole('button', { name: 'Earlier' });
    expect(heading).toHaveClass('text-xs');
    expect(heading.className).not.toMatch(/text-\[0\.75rem\]/);
  });

  it('Earlier starts closed, and its heading opens it', () => {
    renderGroup();

    expect(screen.getByRole('button', { name: 'Earlier' })).toHaveAttribute('aria-expanded', 'false');
    expect(rowTitles()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
    expect(screen.getByRole('button', { name: 'Earlier' })).toHaveAttribute('aria-expanded', 'true');
    expect(rowTitles()).toHaveLength(5);
  });

  it('Today starts open and folds behind its heading the same way', () => {
    renderGroup({ label: 'Today', defaultOpen: true, count: 3 });

    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-expanded', 'true');
    expect(rowTitles()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-expanded', 'false');
    expect(rowTitles()).toEqual([]);
  });

  it('stays as it was left after going to another screen and coming back, and after a reload', () => {
    const first = renderGroup({ label: 'Today', defaultOpen: true, count: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    // Another screen replaces the Chats column; coming back mounts it fresh.
    first.unmount();

    const back = renderGroup({ label: 'Today', defaultOpen: true, count: 3 });
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-expanded', 'false');
    back.unmount();

    // A reload reads the saved choice back from storage.
    expect(JSON.parse(localStorage.getItem('aman-chat-column-folds') ?? '{}')).toEqual({ today: false });
    renderGroup({ label: 'Today', defaultOpen: true, count: 3 });
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows five chats, and each "Show more" press adds five', () => {
    renderGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
    expect(rowTitles()).toEqual(['chat 0', 'chat 1', 'chat 2', 'chat 3', 'chat 4']);

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(rowTitles()).toHaveLength(10);

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(rowTitles()).toHaveLength(12);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('keeps the open chat visible even when it falls past the first five', () => {
    renderGroup({ openKey: '9' });
    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));

    expect(rowTitles()).toEqual(['chat 0', 'chat 1', 'chat 2', 'chat 3', 'chat 4', 'chat 9']);
  });

  it('shows no "Show more" row when the group fits in one page', () => {
    renderGroup({ count: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));

    expect(rowTitles()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('keeps a folded folder folded after going to another screen and coming back', () => {
    const folder = { id: 'work', name: 'Work' };
    const renderFolder = () =>
      render(
        <ChatFolderSection folder={folder} count={1}>
          <div role="listitem">chat in work</div>
        </ChatFolderSection>,
      );
    const first = renderFolder();
    fireEvent.click(screen.getByRole('button', { name: /^Work/ }));
    expect(rowTitles()).toEqual([]);
    first.unmount();

    renderFolder();
    expect(screen.getByRole('button', { name: /^Work/ })).toHaveAttribute('aria-expanded', 'false');
    expect(rowTitles()).toEqual([]);
  });
});
