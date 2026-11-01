// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MemoryVaultEntryRow } from '@/atoms/memory/MemoryVaultEntry.js';
import type { ExplorerMemory } from '@/atoms/memory/memoryExplorer.js';
import { copyText } from '@/utils/copyText.js';

vi.mock('@/utils/copyText.js', () => ({ copyText: vi.fn(async () => {}) }));

const ENTRY: ExplorerMemory = {
  id: 'md:tenant-1:2026-09-27.md#0',
  text: 'Prefers morning meetings',
  timestamp: '2026-09-27T10:00:00.000Z',
  persona: null,
  owner: 'you',
};

function renderRow(overrides: Partial<Parameters<typeof MemoryVaultEntryRow>[0]> = {}) {
  const props = {
    entry: ENTRY,
    highlight: '',
    selected: false,
    onToggleSelected: vi.fn(),
    onSave: vi.fn(async () => {}),
    onForget: vi.fn(),
    ...overrides,
  };
  render(<MemoryVaultEntryRow {...props} />);
  return props;
}

describe('MemoryVaultEntryRow', () => {
  it('renders the memory as formatted text, not as raw markdown', () => {
    renderRow({ entry: { ...ENTRY, text: 'Drinks **tea** every morning' } });

    expect(screen.getByText('tea').tagName).toBe('STRONG');
    expect(screen.queryByText(/\*\*tea\*\*/)).toBeNull();
  });

  it('marks each match of the search text in the rendered memory', () => {
    const { container } = render(
      <MemoryVaultEntryRow
        entry={{ ...ENTRY, text: 'Morning tea, then more morning walks' }}
        highlight="morning"
        selected={false}
        onToggleSelected={vi.fn()}
        onSave={vi.fn(async () => {})}
        onForget={vi.fn()}
      />,
    );

    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
    expect(marks[0]?.textContent).toBe('Morning');
  });

  it('shows raw HTML as text, without running scripts or loading remote pictures', () => {
    const { container } = render(
      <MemoryVaultEntryRow
        entry={{ ...ENTRY, text: 'Safe text <script>window.hacked = true</script> ![pic](https://example.com/a.png)' }}
        highlight=""
        selected={false}
        onToggleSelected={vi.fn()}
        onSave={vi.fn(async () => {})}
        onForget={vi.fn()}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[src="https://example.com/a.png"]')).toBeNull();
    expect(Reflect.get(window, 'hacked')).toBeUndefined();
  });

  it('edits in place and saves the trimmed text', async () => {
    const props = renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByLabelText('Edit memory');
    fireEvent.change(textarea, { target: { value: '  Prefers evening meetings  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(props.onSave).toHaveBeenCalledWith({ entryId: ENTRY.id, text: 'Prefers evening meetings' });
  });

  it('does not save when the text is unchanged or blank', () => {
    renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Edit memory'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the error from a failed save and keeps the edit open', async () => {
    renderRow({ onSave: vi.fn(async () => Promise.reject(new Error('The server is busy.'))) });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit memory'), { target: { value: 'New words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The server is busy.');
    expect(screen.getByLabelText('Edit memory')).toBeInTheDocument();
  });

  it('copies the memory text and confirms it', async () => {
    renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied'));
    expect(copyText).toHaveBeenCalledWith(ENTRY.text);
  });

  it('forgets the memory through the callback, which starts the undo window', () => {
    const props = renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));

    expect(props.onForget).toHaveBeenCalledWith(ENTRY.id);
  });

  it('reports selection changes for the list to track', () => {
    const props = renderRow();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select this memory' }));

    expect(props.onToggleSelected).toHaveBeenCalledWith(ENTRY.id);
  });
});
