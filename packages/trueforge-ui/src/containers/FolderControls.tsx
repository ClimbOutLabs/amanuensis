'use client';

import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';

import { auiButtonClass } from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { auiInputClass } from '../atoms/lib/inputClasses.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../atoms/primitives/Dialog.js';
import { Icon } from '../icons/Icon.js';
import { useChatColumnFold } from '../utils/chatColumnFolds.js';

/** What the folder dialogs need of a folder, so chat folders and space folders share one set of controls. */
export type FolderRow = { id: string; name: string };

/** Folder changes a host saves; chats and spaces each bring their own. */
export interface FolderOperations {
  createFolder(input: { name: string }): Promise<FolderRow>;
  renameFolder(input: { folderId: string; name: string }): Promise<void>;
  deleteFolder(input: { folderId: string }): Promise<void>;
}

export type FolderKind = 'chat' | 'space';

const KIND_WORDS: Record<FolderKind, { one: string; many: string }> = {
  chat: { one: 'chat', many: 'chats' },
  space: { one: 'space', many: 'spaces' },
};

type FolderAction = 'create' | 'move' | 'rename' | 'delete';

/**
 * What the person reads when a folder change fails. Server replies are for developers, so they are
 * never shown: each action gets one plain sentence with the next step.
 */
function folderFailureMessage({ kind, action }: { kind: FolderKind; action: FolderAction }): string {
  switch (action) {
    case 'create':
      return 'Could not create the folder. Try again.';
    case 'move':
      return `Could not move the ${KIND_WORDS[kind].one}. The folder may no longer exist. Refresh the page and try again.`;
    case 'rename':
      return 'Could not rename the folder. The folder may no longer exist. Refresh the page and try again.';
    case 'delete':
      return 'Could not delete the folder. Refresh the page and try again.';
  }
}

/** Escape cancels without saving in every inline rename/create form. */
export function cancelOnEscape(onCancel: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onCancel();
  };
}

/**
 * Lists the folders to choose from and also lets a new one be made on the spot. `onMove` does the
 * actual move, so the dialog works for whatever is being filed.
 */
export function FolderMoveDialog({
  kind,
  folders,
  currentFolderId,
  createFolder,
  onMove,
  open,
  onOpenChange,
}: {
  kind: FolderKind;
  folders: readonly FolderRow[];
  currentFolderId: string | null;
  createFolder: FolderOperations['createFolder'];
  onMove(folderId: string | null): Promise<void>;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const words = KIND_WORDS[kind];
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
  }, [open]);

  const move = async (folderId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await onMove(folderId);
      onOpenChange(false);
    } catch {
      setError(folderFailureMessage({ kind, action: 'move' }));
    } finally {
      setBusy(false);
    }
  };

  const createAndMove = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized.length === 0) return;
    setBusy(true);
    setError(null);
    let action: FolderAction = 'create';
    try {
      const created = await createFolder({ name: normalized });
      action = 'move';
      await onMove(created.id);
      onOpenChange(false);
    } catch {
      setError(folderFailureMessage({ kind, action }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} aria-label={`Move ${words.one} to folder`} className="max-w-md">
      <DialogContent className="gap-5">
        <DialogHeader>
          <DialogTitle>Move {words.one}</DialogTitle>
          <p className="text-sm text-text-secondary">Choose a folder or make a new one.</p>
        </DialogHeader>

        <div
          className="flex max-h-56 flex-col gap-1 overflow-y-auto"
          aria-label={kind === 'chat' ? 'Chat folders' : 'Space folders'}
        >
          {currentFolderId !== null ? (
            <button
              type="button"
              className={auiButtonClass({ variant: 'ghost', className: '!justify-start h-9 px-2.5' })}
              disabled={busy}
              onClick={() => void move(null)}
            >
              <Icon name="xmark" className="size-3.5 text-text-secondary" />
              No folder
            </button>
          ) : null}
          {folders.map(folder => (
            <button
              key={folder.id}
              type="button"
              className={auiButtonClass({
                variant: 'ghost',
                className: cn(
                  '!justify-start h-9 px-2.5',
                  folder.id === currentFolderId && 'bg-dropdown-selected-item-bg text-dropdown-selected-item-text',
                ),
              })}
              disabled={busy || folder.id === currentFolderId}
              onClick={() => void move(folder.id)}
            >
              <Icon name="folder" className="size-4" />
              <span className="truncate">{folder.name}</span>
              {folder.id === currentFolderId ? <Icon name="check" className="ml-auto size-3.5" /> : null}
            </button>
          ))}
          {folders.length === 0 ? (
            <p className="rounded-md bg-secondary-bg px-3 py-2 text-sm text-text-secondary">No folders yet.</p>
          ) : null}
        </div>

        <form
          className="flex items-center gap-2 border-t border-border pt-4"
          onSubmit={event => void createAndMove(event)}
        >
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            maxLength={64}
            placeholder="New folder name"
            aria-label="New folder name"
            className={auiInputClass('h-9')}
            disabled={busy}
          />
          <button
            type="submit"
            className={auiButtonClass({ variant: 'primary', className: 'h-9 shrink-0 px-3' })}
            disabled={busy || name.trim().length === 0}
          >
            Create
          </button>
        </form>
        {error !== null ? (
          <p role="alert" className="text-sm text-failure-bg">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FolderManageDialog({
  kind,
  folder,
  operations,
  open,
  onOpenChange,
}: {
  kind: FolderKind;
  folder: FolderRow;
  operations: FolderOperations;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const words = KIND_WORDS[kind];
  const [name, setName] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(folder.name);
    setError(null);
  }, [folder.name, open]);

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized.length === 0 || normalized === folder.name) return;
    setBusy(true);
    setError(null);
    try {
      await operations.renameFolder({ folderId: folder.id, name: normalized });
      onOpenChange(false);
    } catch {
      setError(folderFailureMessage({ kind, action: 'rename' }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await operations.deleteFolder({ folderId: folder.id });
      onOpenChange(false);
    } catch {
      setError(folderFailureMessage({ kind, action: 'delete' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} aria-label={`Manage ${folder.name}`} className="max-w-md">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Folder settings</DialogTitle>
          <p className="text-sm text-text-secondary">
            Rename this folder or remove it. Removing it keeps every {words.one}.
          </p>
        </DialogHeader>
        <form className="flex items-center gap-2" onSubmit={event => void rename(event)}>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            maxLength={64}
            aria-label="Folder name"
            className={auiInputClass('h-9')}
            disabled={busy}
          />
          <button
            type="submit"
            className={auiButtonClass({ variant: 'secondary', className: 'h-9 shrink-0 px-3' })}
            disabled={busy || name.trim().length === 0 || name.trim() === folder.name}
          >
            Rename
          </button>
        </form>
        {error !== null ? (
          <p role="alert" className="text-sm text-failure-bg">
            {error}
          </p>
        ) : null}
      </DialogContent>
      <DialogFooter className="border-t border-border pt-4">
        <button
          type="button"
          className={auiButtonClass({
            variant: 'ghost',
            className: 'text-failure-bg hover:bg-failure-bg/12 hover:text-failure-bg',
          })}
          disabled={busy}
          onClick={() => void remove()}
        >
          Delete folder
        </button>
        <button
          type="button"
          className={auiButtonClass({ variant: 'secondary' })}
          disabled={busy}
          onClick={() => onOpenChange(false)}
        >
          Close
        </button>
      </DialogFooter>
    </Dialog>
  );
}

/** A collapsible folder with a settings button; the person's open or closed choice is remembered. */
export function FolderSection({
  kind,
  folder,
  count,
  operations,
  children,
}: {
  kind: FolderKind;
  folder: FolderRow;
  count: number;
  /** Null when the host saves no folder changes: the section still folds, but offers no settings. */
  operations: FolderOperations | null;
  children: ReactNode;
}) {
  const [expanded, toggleExpanded] = useChatColumnFold({
    section: kind === 'chat' ? `folder:${folder.id}` : `space-folder:${folder.id}`,
    defaultOpen: true,
  });
  const [manageOpen, setManageOpen] = useState(false);
  return (
    <section aria-label={folder.name} className="mt-1">
      <div className="group/folder flex items-center gap-1 px-1 py-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[1.25rem] border-0 bg-transparent px-2.5 py-1 text-left text-xs font-semibold text-text-secondary hover:bg-ghost-button-hover hover:text-text-primary"
          onClick={toggleExpanded}
        >
          <Icon name="chevron-down" className={cn('size-3 transition-transform', !expanded && '-rotate-90')} />
          <Icon name="folder" className="size-3.5" />
          <span className="truncate">{folder.name}</span>
          <span className="ml-auto tabular-nums text-text-secondary/70">{count}</span>
        </button>
        {operations !== null ? (
          <button
            type="button"
            aria-label={`Manage ${folder.name}`}
            className={auiButtonClass({
              variant: 'ghost',
              size: 'icon',
              className:
                'size-6 shrink-0 border-0 text-text-secondary opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100',
            })}
            onClick={() => setManageOpen(true)}
          >
            <Icon name="ellipsis" className="size-3.5" />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="flex flex-col gap-0.5 pl-2">
          {count === 0 ? <p className="px-2 py-1 text-xs text-text-secondary/70">Empty folder</p> : children}
        </div>
      ) : null}
      {operations !== null ? (
        <FolderManageDialog
          kind={kind}
          folder={folder}
          operations={operations}
          open={manageOpen}
          onOpenChange={setManageOpen}
        />
      ) : null}
    </section>
  );
}

/**
 * Standalone "create an empty folder" form. Deliberately not `FolderMoveDialog`'s "New folder
 * name" input: that one always also moves the item it was opened for, which has no meaning from a
 * header with nothing in context. Both call the same `createFolder`.
 */
function FolderCreateDialog({
  kind,
  createFolder,
  open,
  onOpenChange,
}: {
  kind: FolderKind;
  createFolder: FolderOperations['createFolder'];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const words = KIND_WORDS[kind];
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
  }, [open]);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await createFolder({ name: normalized });
      onOpenChange(false);
    } catch {
      setError(folderFailureMessage({ kind, action: 'create' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} aria-label="New folder" className="max-w-md">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <p className="text-sm text-text-secondary">Give the folder a name. Move {words.many} into it afterward.</p>
        </DialogHeader>
        <form className="flex items-center gap-2" onSubmit={event => void create(event)}>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            onKeyDown={cancelOnEscape(() => onOpenChange(false))}
            maxLength={64}
            placeholder="Folder name"
            aria-label="New folder name"
            className={auiInputClass('h-9')}
            disabled={busy}
            autoFocus
          />
          <button
            type="submit"
            className={auiButtonClass({ variant: 'primary', className: 'h-9 shrink-0 px-3' })}
            disabled={busy || name.trim().length === 0}
          >
            Create
          </button>
        </form>
        {error !== null ? (
          <p role="alert" className="text-sm text-failure-bg">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Header action that makes folder creation discoverable. `labeled` shows the words beside the icon. */
export function NewFolderControl({
  kind,
  createFolder,
  labeled = false,
}: {
  kind: FolderKind;
  createFolder: FolderOperations['createFolder'];
  labeled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="New folder"
        title="New folder"
        className={
          labeled
            ? auiButtonClass({ variant: 'secondary', size: 'small' })
            : auiButtonClass({
                variant: 'ghost',
                size: 'icon',
                className:
                  'size-6 shrink-0 border border-border text-text-secondary hover:bg-ghost-button-hover hover:text-text-primary',
              })
        }
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" className="size-3.5" />
        {labeled ? 'New folder' : null}
      </button>
      <FolderCreateDialog kind={kind} createFolder={createFolder} open={open} onOpenChange={setOpen} />
    </>
  );
}
