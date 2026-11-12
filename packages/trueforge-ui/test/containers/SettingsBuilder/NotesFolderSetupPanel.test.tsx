// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NotesFolderSetupPanel from '@/containers/SettingsBuilder/NotesFolderSetupPanel.js';
import type { NotesFolderSetupPort, NotesFolderStatus } from '@/server/notesFolderSetup.js';

// jsdom does not implement <dialog>.showModal()/close(); CenteredModal calls both.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function showModal(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

afterEach(() => {
  if (originalShowModal === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  else Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  if (originalClose === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  else Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  vi.restoreAllMocks();
});

function statusOf(overrides: Partial<NotesFolderStatus> = {}): NotesFolderStatus {
  return {
    state: 'not_connected',
    folderPath: null,
    inboxFile: 'Aman inbox.md',
    noteCount: null,
    ...overrides,
  };
}

function makePort(status: NotesFolderStatus) {
  const port: NotesFolderSetupPort = {
    getNotesFolderStatus: vi.fn(async () => status),
    saveNotesFolder: vi.fn(async () =>
      statusOf({ state: 'connected', folderPath: '/notes', inboxFile: 'Aman inbox.md', noteCount: 12 }),
    ),
    removeNotesFolder: vi.fn(async () => statusOf()),
  };
  return port;
}

function renderPanel(port: NotesFolderSetupPort) {
  return render(<NotesFolderSetupPanel open onOpenChange={() => {}} port={port} onChanged={() => {}} />);
}

describe('the notes folder setup panel', () => {
  it('asks for a folder and an inbox file, with no password anywhere', async () => {
    renderPanel(makePort(statusOf()));
    expect(await screen.findByLabelText('Folder')).toBeDefined();
    expect(screen.getByLabelText('Inbox file')).toBeDefined();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDefined();
  });

  it('says the Docker install cannot use a notes folder yet, and that Aman Setup on Windows is the same', async () => {
    renderPanel(makePort(statusOf()));
    expect(await screen.findByText(/Aman Setup on Windows uses Docker/)).toBeDefined();
    expect(screen.getByText(/cannot use a notes folder yet either/)).toBeDefined();
  });

  it('saves the folder and the inbox name the person typed', async () => {
    const port = makePort(statusOf());
    renderPanel(port);
    fireEvent.change(await screen.findByLabelText('Folder'), { target: { value: '/notes' } });
    fireEvent.change(screen.getByLabelText('Inbox file'), { target: { value: 'Ideas in.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(port.saveNotesFolder).toHaveBeenCalledWith({ folderPath: '/notes', inboxFile: 'Ideas in.md' }),
    );
    expect(await screen.findByText(/Connected to/)).toBeDefined();
    expect(screen.getByText(/It holds 12 notes\./)).toBeDefined();
  });

  it("shows the server's own line when the folder cannot be used", async () => {
    const port = makePort(statusOf());
    port.saveNotesFolder = vi.fn(async () => {
      throw new Error(
        'That folder is where Aman keeps its own memory, so it cannot be your notes folder too. Pick the folder that holds your notes, such as the vault you open in Obsidian.',
      );
    });
    renderPanel(port);
    fireEvent.change(await screen.findByLabelText('Folder'), { target: { value: '/memory' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Pick the folder that holds your notes'),
    );
  });

  it('shows the saved folder and removes it only after a confirm', async () => {
    const port = makePort(statusOf({ state: 'connected', folderPath: '/notes', noteCount: 3 }));
    renderPanel(port);
    expect(await screen.findByText(/It holds 3 notes\./)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/Your notes are not changed/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder' }));
    await waitFor(() => expect(port.removeNotesFolder).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('Folder')).toBeDefined();
  });

  it('says the folder is not working when it is saved but cannot be found', async () => {
    const port = makePort(statusOf({ state: 'not_working', folderPath: '/gone', noteCount: null }));
    renderPanel(port);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('cannot find it right now'),
    );
    expect(screen.getByLabelText('Folder')).toHaveProperty('value', '/gone');
  });
});
