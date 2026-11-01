// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpacesView } from '@/containers/SpacesView.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import { SpaceProvider, type Space, type SpaceFolder, type SpaceStore } from '@/server/SpaceContext.js';

// jsdom does not implement HTMLDialogElement.showModal()/close(); the folder dialogs call both.
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
      this.dispatchEvent(new Event('close'));
    },
  });
  window.localStorage.clear();
});

afterEach(() => {
  for (const [name, original] of [
    ['showModal', originalShowModal],
    ['close', originalClose],
  ] as const) {
    if (original === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, original);
  }
});

function makeSpace(overrides: Partial<Space> & Pick<Space, 'id' | 'name'>): Space {
  return {
    purpose: `About ${overrides.name}.`,
    status: 'active',
    body: 'Body.',
    format: 'markdown',
    folder_id: null,
    revision: 2,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

/** Behaves like the server: folder changes are kept, and deleting a folder unfiles its spaces. */
function folderStore({ spaces, folders }: { spaces: Space[]; folders: SpaceFolder[] }): SpaceStore {
  return {
    list: vi.fn(async () => spaces.map(space => ({ ...space }))),
    get: vi.fn(async ({ spaceId }) => {
      const found = spaces.find(space => space.id === spaceId);
      if (found === undefined) throw new Error(`Space not found: ${spaceId}`);
      return found;
    }),
    delete: vi.fn(async () => {}),
    listFolders: vi.fn(async () => folders.map(folder => ({ ...folder }))),
    createFolder: vi.fn(async ({ name }) => {
      const created = { id: `folder-${String(folders.length + 1)}`, name };
      folders.push(created);
      return created;
    }),
    renameFolder: vi.fn(async ({ folderId, name }) => {
      const folder = folders.find(candidate => candidate.id === folderId);
      if (folder === undefined) throw new Error('Folder not found');
      folder.name = name;
      return { ...folder };
    }),
    deleteFolder: vi.fn(async ({ folderId }) => {
      folders.splice(
        folders.findIndex(folder => folder.id === folderId),
        1,
      );
      for (const space of spaces) if (space.folder_id === folderId) space.folder_id = null;
    }),
    setSpaceFolder: vi.fn(async ({ spaceId, folderId }) => {
      const space = spaces.find(candidate => candidate.id === spaceId);
      if (space !== undefined) space.folder_id = folderId;
    }),
  };
}

function OpenOnMount({ spaceId }: { spaceId?: string }) {
  const { openSpaces } = useShellMode();
  useEffect(() => {
    openSpaces(spaceId ?? null);
  }, [openSpaces, spaceId]);
  return null;
}

function Harness({ store, initialSpaceId }: { store: SpaceStore; initialSpaceId?: string }) {
  return (
    <ShellModeProvider>
      <SpaceProvider store={store}>
        <OpenOnMount spaceId={initialSpaceId} />
        <SpacesView />
      </SpaceProvider>
    </ShellModeProvider>
  );
}

const HOMES = makeSpace({ id: 's-homes', name: 'Spain houses', folder_id: 'folder-a' });
const TRIP = makeSpace({ id: 's-trip', name: 'Iceland trip' });

describe('Spaces list folders', () => {
  it('shows each folder as a section above the spaces that have no folder', async () => {
    render(
      <Harness
        store={folderStore({
          spaces: [HOMES, TRIP].map(s => ({ ...s })),
          folders: [{ id: 'folder-a', name: 'Moving' }],
        })}
      />,
    );

    const section = await screen.findByRole('region', { name: 'Moving' });
    expect(within(section).getByText('Spain houses')).toBeInTheDocument();
    expect(within(section).queryByText('Iceland trip')).not.toBeInTheDocument();
    const trip = screen.getByText('Iceland trip');
    expect(section.compareDocumentPosition(trip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('collapses and opens a folder, and says when it is empty', async () => {
    render(<Harness store={folderStore({ spaces: [{ ...TRIP }], folders: [{ id: 'folder-a', name: 'Moving' }] })} />);

    const section = await screen.findByRole('region', { name: 'Moving' });
    expect(within(section).getByText('Empty folder')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { expanded: true }));
    expect(within(section).queryByText('Empty folder')).not.toBeInTheDocument();
  });

  it('makes a new folder from the New folder button', async () => {
    const store = folderStore({ spaces: [{ ...TRIP }], folders: [] });
    render(<Harness store={store} />);

    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'New folder name' }), {
      target: { value: '  Travel ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(store.createFolder).toHaveBeenCalledWith({ name: 'Travel' }));
    expect(await screen.findByRole('region', { name: 'Travel' })).toBeInTheDocument();
  });

  it('renames a folder from its settings', async () => {
    const store = folderStore({ spaces: [{ ...HOMES }], folders: [{ id: 'folder-a', name: 'Moving' }] });
    render(<Harness store={store} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Manage Moving' }));
    expect(screen.getByText(/Removing it keeps every space\./)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Relocation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(store.renameFolder).toHaveBeenCalledWith({ folderId: 'folder-a', name: 'Relocation' }));
    expect(await screen.findByRole('region', { name: 'Relocation' })).toBeInTheDocument();
  });

  it('deleting a folder keeps its spaces and lists them with the rest', async () => {
    const store = folderStore({ spaces: [{ ...HOMES }], folders: [{ id: 'folder-a', name: 'Moving' }] });
    render(<Harness store={store} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Manage Moving' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete folder' }));

    await waitFor(() => expect(store.deleteFolder).toHaveBeenCalledWith({ folderId: 'folder-a' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Moving' })).not.toBeInTheDocument());
    expect(screen.getByText('Spain houses')).toBeInTheDocument();
    expect(store.delete).not.toHaveBeenCalled();
  });
});

describe('Space page folder actions', () => {
  it('moves the space into a folder from Space actions', async () => {
    const store = folderStore({ spaces: [{ ...TRIP }], folders: [{ id: 'folder-a', name: 'Travel' }] });
    render(<Harness store={store} initialSpaceId="s-trip" />);

    await screen.findByRole('heading', { level: 1, name: 'Iceland trip' });
    fireEvent.click(screen.getByRole('button', { name: 'Space actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Travel' }));

    await waitFor(() => expect(store.setSpaceFolder).toHaveBeenCalledWith({ spaceId: 's-trip', folderId: 'folder-a' }));
  });

  it('makes a new folder and moves the space into it in one step', async () => {
    const store = folderStore({ spaces: [{ ...TRIP }], folders: [] });
    render(<Harness store={store} initialSpaceId="s-trip" />);

    await screen.findByRole('heading', { level: 1, name: 'Iceland trip' });
    fireEvent.click(screen.getByRole('button', { name: 'Space actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'New folder name' }), { target: { value: 'Trips' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(store.createFolder).toHaveBeenCalledWith({ name: 'Trips' }));
    await waitFor(() => expect(store.setSpaceFolder).toHaveBeenCalledWith({ spaceId: 's-trip', folderId: 'folder-1' }));
  });

  it('takes the space out of its folder with No folder', async () => {
    const store = folderStore({ spaces: [{ ...HOMES }], folders: [{ id: 'folder-a', name: 'Moving' }] });
    render(<Harness store={store} initialSpaceId="s-homes" />);

    await screen.findByRole('heading', { level: 1, name: 'Spain houses' });
    fireEvent.click(screen.getByRole('button', { name: 'Space actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'No folder' }));

    await waitFor(() => expect(store.setSpaceFolder).toHaveBeenCalledWith({ spaceId: 's-homes', folderId: null }));
  });

  it('shows a plain sentence, not the server reply, and keeps the space where it was when the move fails', async () => {
    const store = folderStore({ spaces: [{ ...TRIP }], folders: [{ id: 'folder-a', name: 'Travel' }] });
    store.setSpaceFolder = vi.fn(async () => {
      throw new Error('{"error":{"code":"space_folder_not_found"}}');
    });
    render(<Harness store={store} initialSpaceId="s-trip" />);

    await screen.findByRole('heading', { level: 1, name: 'Iceland trip' });
    fireEvent.click(screen.getByRole('button', { name: 'Space actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Travel' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not move the space. The folder may no longer exist. Refresh the page and try again.',
    );
    expect(screen.queryByText(/space_folder_not_found/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'No folder' })).not.toBeInTheDocument();
  });

  it('says what to do next when a folder rename or delete fails', async () => {
    const store = folderStore({ spaces: [{ ...HOMES }], folders: [{ id: 'folder-a', name: 'Moving' }] });
    store.renameFolder = vi.fn(async () => {
      throw new Error('{"error":"raw"}');
    });
    store.deleteFolder = vi.fn(async () => {
      throw new Error('');
    });
    render(<Harness store={store} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Manage Moving' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Relocation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not rename the folder. The folder may no longer exist. Refresh the page and try again.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete folder' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not delete the folder. Refresh the page and try again.',
      ),
    );
  });

  it('says what to do next when a new folder cannot be made', async () => {
    const store = folderStore({ spaces: [{ ...TRIP }], folders: [] });
    store.createFolder = vi.fn(async () => {
      throw new Error('{"error":"raw"}');
    });
    render(<Harness store={store} />);

    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), { target: { value: 'Travel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create the folder. Try again.');
  });
});
