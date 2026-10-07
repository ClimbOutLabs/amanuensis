// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MemoryVaultEntryRow } from '@/atoms/memory/MemoryVaultEntry.js';

const ENTRY = {
  id: 'md:tenant-1:2026-09-27.md#0',
  text: 'Prefers morning meetings',
  timestamp: '2026-09-27T10:00:00.000Z',
  persona: null,
};

describe('MemoryVaultEntryRow', () => {
  it('renders the fact text and edits inline with save/cancel', async () => {
    const onSave = vi.fn(async () => {});
    const onDelete = vi.fn(async () => {});
    render(<MemoryVaultEntryRow entry={ENTRY} onSave={onSave} onDelete={onDelete} />);

    expect(screen.getByText('Prefers morning meetings')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: `Edit fact ${ENTRY.id}` }));
    const textarea = screen.getByLabelText('Edit fact');
    fireEvent.change(textarea, { target: { value: 'Prefers evening meetings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ entryId: ENTRY.id, text: 'Prefers evening meetings' });
  });

  it('cancels an edit without saving', () => {
    const onSave = vi.fn(async () => {});
    const onDelete = vi.fn(async () => {});
    render(<MemoryVaultEntryRow entry={ENTRY} onSave={onSave} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: `Edit fact ${ENTRY.id}` }));
    fireEvent.change(screen.getByLabelText('Edit fact'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Prefers morning meetings')).toBeDefined();
  });

  it('asks for confirmation before deleting', async () => {
    const onSave = vi.fn(async () => {});
    const onDelete = vi.fn(async () => {});
    render(<MemoryVaultEntryRow entry={ENTRY} onSave={onSave} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: `Delete fact ${ENTRY.id}` }));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete this fact' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(onDelete).toHaveBeenCalledWith(ENTRY.id);
  });
});
