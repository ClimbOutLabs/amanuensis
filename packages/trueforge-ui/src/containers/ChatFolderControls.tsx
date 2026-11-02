'use client';

import { useAui } from '@assistant-ui/react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { auiButtonClass } from '../atoms/lib/buttonClasses.js';
import { useCompactLayout } from '../atoms/lib/CompactLayoutContext.js';
import { auiInputClass } from '../atoms/lib/inputClasses.js';
import { useIsMobile } from '../atoms/lib/useIsMobile.js';
import { BottomSheet } from '../atoms/primitives/BottomSheet.js';
import { Button } from '../atoms/primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../atoms/primitives/Dialog.js';
import { DropdownMenu } from '../atoms/primitives/DropdownMenu.js';
import { CHAT_TITLE_MAX_LENGTH, normalizeChatTitle, useSaveChatTitle } from '../hooks/useChatTitleSave.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalChatFolders, type ChatFolder } from '../server/ChatFolderContext.js';
import { cancelOnEscape, FolderMoveDialog, FolderSection, NewFolderControl } from './FolderControls.js';
import { useToasterOptional } from './ToasterContainer.js';

const deleteItemClass =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-failure-bg outline-none transition-colors hover:bg-failure-bg/12 hover:text-failure-bg focus:bg-failure-bg/12 focus:text-failure-bg data-[highlighted]:bg-failure-bg/12 data-[highlighted]:text-failure-bg';

const menuItemClass =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-primary outline-none transition-colors hover:bg-ghost-button-hover focus:bg-ghost-button-hover data-[highlighted]:bg-ghost-button-hover';

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
  if (chatFolders === null) return null;
  return (
    <FolderMoveDialog
      kind="chat"
      folders={chatFolders.folders}
      currentFolderId={currentFolderId}
      createFolder={chatFolders.createFolder}
      onMove={folderId => chatFolders.moveChat({ sessionId, folderId })}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

/**
 * Rename dialog, styled to match the folder settings rename form. Folder rows that are
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
    } catch {
      setError('Could not rename the chat. Try again.');
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
  const useSheet = isMobile || compact;

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
      <DropdownMenu
        align="end"
        trigger={
          <button type="button" aria-label="Session actions" title="Session actions" className={moreButtonClass}>
            <Icon name="ellipsis" className="size-3.5" />
          </button>
        }
        className="z-50 min-w-[10rem] rounded-[1.25rem] border border-border bg-card-bg p-1 text-text-primary"
      >
        <div role="menu" className="flex flex-col">
          {canRename ? (
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => setRenameOpen(true)}>
              <Icon name="pencil" className="size-3.5" />
              Rename
            </button>
          ) : null}
          {chatFolders !== null ? (
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => setFolderOpen(true)}>
              <Icon name="folder" className="size-3.5" />
              Move to folder
            </button>
          ) : null}
          {canDelete ? (
            <button type="button" role="menuitem" className={deleteItemClass} onClick={() => setDeleteOpen(true)}>
              <Icon name="trash" className="size-3.5" />
              Delete
            </button>
          ) : null}
        </div>
      </DropdownMenu>
      {folderDialog}
      {renameDialog}
      {deleteDialog}
    </>
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
  const chatFolders = useOptionalChatFolders();
  return (
    <FolderSection kind="chat" folder={folder} count={count} operations={chatFolders}>
      {children}
    </FolderSection>
  );
}

/** Sidebar header action that makes folder creation discoverable (chatFolderStore.createFolder). */
export function NewFolderButton() {
  const chatFolders = useOptionalChatFolders();
  if (chatFolders === null) return null;
  return <NewFolderControl kind="chat" createFolder={chatFolders.createFolder} />;
}
