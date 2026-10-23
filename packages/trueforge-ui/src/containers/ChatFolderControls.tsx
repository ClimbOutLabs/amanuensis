'use client';

import { ThreadListItemMorePrimitive, useAui } from '@assistant-ui/react';
import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';

import { auiButtonClass } from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { useCompactLayout } from '../atoms/lib/CompactLayoutContext.js';
import { auiInputClass } from '../atoms/lib/inputClasses.js';
import { useIsMobile } from '../atoms/lib/useIsMobile.js';
import { BottomSheet } from '../atoms/primitives/BottomSheet.js';
import { Button } from '../atoms/primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../atoms/primitives/Dialog.js';
import { CHAT_TITLE_MAX_LENGTH, normalizeChatTitle, useSaveChatTitle } from '../hooks/useChatTitleSave.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalChatFolders, type ChatFolder } from '../server/ChatFolderContext.js';
import { useToasterOptional } from './ToasterContainer.js';

/** Escape cancels without saving in every inline rename/create form below. */
function cancelOnEscape(onCancel: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onCancel();
  };
}

const deleteItemClass =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-failure-bg outline-none transition-colors hover:bg-failure-bg/12 hover:text-failure-bg focus:bg-failure-bg/12 focus:text-failure-bg data-[highlighted]:bg-failure-bg/12 data-[highlighted]:text-failure-bg';

const menuItemClass =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-primary outline-none transition-colors hover:bg-ghost-button-hover focus:bg-ghost-button-hover data-[highlighted]:bg-ghost-button-hover';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Could not update this chat';
}

function ChatFolderDialog({
  sessionId,
  currentFolderId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  currentFolderId: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const chatFolders = useOptionalChatFolders();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
  }, [open]);

  if (chatFolders === null) return null;

  const move = async (folderId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await chatFolders.moveChat({ sessionId, folderId });
      onOpenChange(false);
    } catch (moveError) {
      setError(errorMessage(moveError));
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
    try {
      const created = await chatFolders.createFolder({ name: normalized });
      await chatFolders.moveChat({ sessionId, folderId: created.id });
      onOpenChange(false);
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} aria-label="Move chat to folder" className="max-w-md">
      <DialogContent className="gap-5">
        <DialogHeader>
          <DialogTitle>Move chat</DialogTitle>
          <p className="text-sm text-text-secondary">Choose a folder or make a new one.</p>
        </DialogHeader>

        <div className="flex max-h-56 flex-col gap-1 overflow-y-auto" aria-label="Chat folders">
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
          {chatFolders.folders.map(folder => (
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
          {chatFolders.folders.length === 0 ? (
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

/**
 * Rename dialog, styled to match `FolderManageDialog`'s rename form below. Folder rows that are
 * not thread-list items also pass `onRenamed`, so the saved title reaches the row they render.
 */
function RenameChatDialog({
  sessionId,
  currentTitle,
  open,
  onOpenChange,
  onRenamed,
}: {
  sessionId: string;
  currentTitle: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRenamed?: (title: string) => void;
}) {
  const saveTitle = useSaveChatTitle();
  const [name, setName] = useState(currentTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(currentTitle);
    setError(null);
  }, [currentTitle, open]);

  if (saveTitle === null) return null;

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeChatTitle(name);
    if (normalized.length === 0 || normalized === currentTitle) return;
    setBusy(true);
    setError(null);
    try {
      await saveTitle({ sessionId, title: normalized });
      onRenamed?.(normalized);
      onOpenChange(false);
    } catch (renameError) {
      setError(errorMessage(renameError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} aria-label="Rename chat" className="max-w-md">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename chat</DialogTitle>
        </DialogHeader>
        <form className="flex items-center gap-2" onSubmit={event => void rename(event)}>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            onKeyDown={cancelOnEscape(() => onOpenChange(false))}
            maxLength={CHAT_TITLE_MAX_LENGTH}
            aria-label="Chat title"
            className={auiInputClass('h-9')}
            disabled={busy}
            autoFocus
          />
          <button
            type="submit"
            className={auiButtonClass({ variant: 'secondary', className: 'h-9 shrink-0 px-3' })}
            disabled={busy || normalizeChatTitle(name).length === 0 || normalizeChatTitle(name) === currentTitle}
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
    </Dialog>
  );
}

/**
 * Confirms before the runtime deletes this row (`adapter.delete` → `server.deleteSession`).
 * The server deletes at once, so the success toast offers no undo.
 */
function ChatDeleteDialog({
  title,
  open,
  onOpenChange,
  onDelete,
}: {
  title: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onDelete?: () => Promise<void>;
}) {
  const aui = useAui();
  const toaster = useToasterOptional();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
  }, [open]);

  const trimmedTitle = title.trim();
  const body = trimmedTitle.length > 0 ? `${trimmedTitle} will be gone for good.` : 'This chat will be gone for good.';

  const deleteChat = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // This may unmount the row that owns the dialog, so the toast is shown from the provider above it.
      if (onDelete !== undefined) {
        await onDelete();
      } else {
        await aui.threadListItem().delete();
      }
      toaster?.showSuccess({ title: 'Chat deleted.' });
      onOpenChange(false);
    } catch {
      setError('Could not delete this chat. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!busy) onOpenChange(next);
      }}
      aria-label="Delete chat"
      className="max-w-md"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this chat?</DialogTitle>
          <p className="text-text-secondary text-sm">{body}</p>
        </DialogHeader>
        {error !== null ? (
          <p role="alert" className="text-sm text-failure-bg">
            {error}
          </p>
        ) : null}
      </DialogContent>
      <DialogFooter>
        <Button.Secondary type="button" disabled={busy} onClick={() => onOpenChange(false)}>
          Keep
        </Button.Secondary>
        <Button.Destructive type="button" disabled={busy} onClick={() => void deleteChat()}>
          Delete
        </Button.Destructive>
      </DialogFooter>
    </Dialog>
  );
}

export function ThreadListItemActions({
  sessionId,
  currentFolderId,
  canDelete,
  canRename,
  title,
  onDelete,
  onRenamed,
}: {
  sessionId: string;
  currentFolderId: string | null;
  canDelete: boolean;
  canRename: boolean;
  title: string;
  /**
   * Folder rows that are not thread-list items delete through this instead of the
   * runtime's item delete, after the same confirmation. A failure is shown in that dialog.
   */
  onDelete?: () => Promise<void>;
  /** Folder rows that are not thread-list items update their title through this after a rename saves. */
  onRenamed?: (title: string) => void;
}) {
  const compact = useCompactLayout();
  const isMobile = useIsMobile();
  const chatFolders = useOptionalChatFolders();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement>();
  const useSheet = isMobile || compact;
  const setTriggerElement = useCallback((element: HTMLButtonElement | null) => {
    const themeRoot = element?.closest('.aui-theme-root');
    setPortalContainer(themeRoot instanceof HTMLElement ? themeRoot : undefined);
  }, []);

  const moreButtonClass = auiButtonClass({
    variant: 'ghost',
    size: 'icon',
    className: 'size-7 shrink-0 text-text-secondary hover:bg-transparent hover:text-text-primary',
  });

  const folderDialog = (
    <ChatFolderDialog
      sessionId={sessionId}
      currentFolderId={currentFolderId}
      open={folderOpen}
      onOpenChange={setFolderOpen}
    />
  );
  const renameDialog = canRename ? (
    <RenameChatDialog
      sessionId={sessionId}
      currentTitle={title}
      open={renameOpen}
      onOpenChange={setRenameOpen}
      onRenamed={onRenamed}
    />
  ) : null;
  const deleteDialog = canDelete ? (
    <ChatDeleteDialog title={title} open={deleteOpen} onOpenChange={setDeleteOpen} onDelete={onDelete} />
  ) : null;

  if (useSheet) {
    return (
      <>
        <button
          type="button"
          aria-label="Session actions"
          title="Session actions"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          className={moreButtonClass}
          onClick={() => setSheetOpen(true)}
        >
          <Icon name="ellipsis" className="size-3.5" />
        </button>
        {sheetOpen ? (
          <BottomSheet open onOpenChange={setSheetOpen} aria-label="Session actions">
            <div className="flex flex-col gap-1 p-2" role="menu">
              {canRename ? (
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => {
                    setSheetOpen(false);
                    setRenameOpen(true);
                  }}
                >
                  <Icon name="pencil" className="size-3.5" />
                  Rename
                </button>
              ) : null}
              {chatFolders !== null ? (
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => {
                    setSheetOpen(false);
                    setFolderOpen(true);
                  }}
                >
                  <Icon name="folder" className="size-3.5" />
                  Move to folder
                </button>
              ) : null}
              {canDelete ? (
                <button
                  type="button"
                  role="menuitem"
                  className={deleteItemClass}
                  onClick={() => {
                    setSheetOpen(false);
                    setDeleteOpen(true);
                  }}
                >
                  <Icon name="trash" className="size-3.5" />
                  Delete
                </button>
              ) : null}
            </div>
          </BottomSheet>
        ) : null}
        {folderDialog}
        {renameDialog}
        {deleteDialog}
      </>
    );
  }

  return (
    <>
      <ThreadListItemMorePrimitive.Root sharedFocusGroup>
        <ThreadListItemMorePrimitive.Trigger
          ref={setTriggerElement}
          aria-label="Session actions"
          title="Session actions"
          className={moreButtonClass}
        >
          <Icon name="ellipsis" className="size-3.5" />
        </ThreadListItemMorePrimitive.Trigger>
        <ThreadListItemMorePrimitive.Content
          portalProps={{ container: portalContainer }}
          align="end"
          sideOffset={4}
          className="font-sans-flex z-50 min-w-[10rem] rounded-md border border-border bg-card-bg p-1 text-text-primary shadow-md"
        >
          {canRename ? (
            <ThreadListItemMorePrimitive.Item className={menuItemClass} onSelect={() => setRenameOpen(true)}>
              <Icon name="pencil" className="size-3.5" />
              Rename
            </ThreadListItemMorePrimitive.Item>
          ) : null}
          {chatFolders !== null ? (
            <ThreadListItemMorePrimitive.Item className={menuItemClass} onSelect={() => setFolderOpen(true)}>
              <Icon name="folder" className="size-3.5" />
              Move to folder
            </ThreadListItemMorePrimitive.Item>
          ) : null}
          {canDelete ? (
            <ThreadListItemMorePrimitive.Item className={deleteItemClass} onSelect={() => setDeleteOpen(true)}>
              <Icon name="trash" className="size-3.5" />
              Delete
            </ThreadListItemMorePrimitive.Item>
          ) : null}
        </ThreadListItemMorePrimitive.Content>
      </ThreadListItemMorePrimitive.Root>
      {folderDialog}
      {renameDialog}
      {deleteDialog}
    </>
  );
}

function FolderManageDialog({
  folder,
  open,
  onOpenChange,
}: {
  folder: ChatFolder;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const chatFolders = useOptionalChatFolders();
  const [name, setName] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(folder.name);
    setError(null);
  }, [folder.name, open]);

  if (chatFolders === null) return null;

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized.length === 0 || normalized === folder.name) return;
    setBusy(true);
    setError(null);
    try {
      await chatFolders.renameFolder({ folderId: folder.id, name: normalized });
      onOpenChange(false);
    } catch (renameError) {
      setError(errorMessage(renameError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await chatFolders.deleteFolder({ folderId: folder.id });
      onOpenChange(false);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} aria-label={`Manage ${folder.name}`} className="max-w-md">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Folder settings</DialogTitle>
          <p className="text-sm text-text-secondary">Rename this folder or remove it. Removing it keeps every chat.</p>
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

export function ChatFolderSection({
  folder,
  count,
  children,
}: {
  folder: ChatFolder;
  count: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const [manageOpen, setManageOpen] = useState(false);
  return (
    <section aria-label={folder.name} className="mt-1">
      <div className="group/folder flex items-center gap-1 px-1 py-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-semibold text-text-secondary hover:bg-ghost-button-hover hover:text-text-primary"
          onClick={() => setExpanded(value => !value)}
        >
          <Icon name="chevron-down" className={cn('size-3 transition-transform', !expanded && '-rotate-90')} />
          <Icon name="folder" className="size-3.5" />
          <span className="truncate">{folder.name}</span>
          <span className="ml-auto tabular-nums text-text-secondary/70">{count}</span>
        </button>
        <button
          type="button"
          aria-label={`Manage ${folder.name}`}
          className={auiButtonClass({
            variant: 'ghost',
            size: 'icon',
            className:
              'size-6 shrink-0 text-text-secondary opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100',
          })}
          onClick={() => setManageOpen(true)}
        >
          <Icon name="ellipsis" className="size-3.5" />
        </button>
      </div>
      {expanded ? (
        <div className="flex flex-col gap-0.5 pl-2">
          {count === 0 ? <p className="px-2 py-1 text-xs text-text-secondary/70">Empty folder</p> : children}
        </div>
      ) : null}
      <FolderManageDialog folder={folder} open={manageOpen} onOpenChange={setManageOpen} />
    </section>
  );
}

/**
 * Standalone "create an empty folder" form. Deliberately not `ChatFolderDialog`'s "New folder
 * name" input above: that input always also moves the chat the dialog was opened for
 * (`createAndMove`), which has no meaning from a sidebar header with no chat in context. Both
 * forms call the same `chatFolders.createFolder`, so there is still one creation code path.
 */
function CreateFolderDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const chatFolders = useOptionalChatFolders();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
  }, [open]);

  if (chatFolders === null) return null;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await chatFolders.createFolder({ name: normalized });
      onOpenChange(false);
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} aria-label="New folder" className="max-w-md">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <p className="text-sm text-text-secondary">Give the folder a name. Move chats into it afterward.</p>
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

/** Sidebar header action that makes folder creation discoverable (chatFolderStore.createFolder). */
export function NewFolderButton() {
  const chatFolders = useOptionalChatFolders();
  const [open, setOpen] = useState(false);

  if (chatFolders === null) return null;

  return (
    <>
      <button
        type="button"
        aria-label="New folder"
        title="New folder"
        className={auiButtonClass({
          variant: 'ghost',
          size: 'icon',
          className: 'size-6 shrink-0 text-text-secondary hover:bg-ghost-button-hover hover:text-text-primary',
        })}
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" className="size-3.5" />
      </button>
      <CreateFolderDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
