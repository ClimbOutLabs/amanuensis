import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EarlierChats } from '@/containers/RecentChatsGroups.js';

function renderRow(index: number) {
  return (
    <div key={index} role="listitem">
      chat {index}
    </div>
  );
}

function rowTitles() {
  return screen.queryAllByRole('listitem').map(row => row.textContent);
}

const indices = Array.from({ length: 12 }, (_, index) => index);

describe('EarlierChats', () => {
  it('starts closed, and its heading opens it', () => {
    render(<EarlierChats indices={indices} openIndex={undefined} renderRow={renderRow} />);

    expect(screen.getByRole('button', { name: 'Earlier' })).toHaveAttribute('aria-expanded', 'false');
    expect(rowTitles()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
    expect(screen.getByRole('button', { name: 'Earlier' })).toHaveAttribute('aria-expanded', 'true');
    expect(rowTitles()).toHaveLength(5);
  });

  it('shows five chats, and each "Show more" press adds five', () => {
    render(<EarlierChats indices={indices} openIndex={undefined} renderRow={renderRow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
    expect(rowTitles()).toEqual(['chat 0', 'chat 1', 'chat 2', 'chat 3', 'chat 4']);

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(rowTitles()).toHaveLength(10);

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(rowTitles()).toHaveLength(12);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('keeps the open chat visible even when it falls past the first five', () => {
    render(<EarlierChats indices={indices} openIndex={9} renderRow={renderRow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));

    expect(rowTitles()).toEqual(['chat 0', 'chat 1', 'chat 2', 'chat 3', 'chat 4', 'chat 9']);
  });

  it('shows no "Show more" row when the group fits in one page', () => {
    render(<EarlierChats indices={[0, 1, 2]} openIndex={undefined} renderRow={renderRow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));

    expect(rowTitles()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
});
