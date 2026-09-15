'use client';

import { ThreadListItemMorePrimitive, ThreadListItemPrimitive } from '@assistant-ui/react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { auiButtonClass } from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { useCompactLayout } from '../atoms/lib/CompactLayoutContext.js';
import { auiInputClass } from '../atoms/lib/inputClasses.js';
import { useIsMobile } from '../atoms/lib/useIsMobile.js';
import { BottomSheet } from '../atoms/primitives/BottomSheet.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../atoms/primitives/Dialog.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalChatFolders, type ChatFolder } from '../server/ChatFolderContext.js';

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

export function ThreadListItemActions({
  sessionId,
  currentFolderId,
  canDelete,
}: {
  sessionId: string;
  currentFolderId: string | null;
  canDelete: boolean;
}) {
  const compact = useCompactLayout();
  const isMobile = useIsMobile();
  const chatFolders = useOptionalChatFolders();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
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
                <ThreadListItemPrimitive.Delete className={deleteItemClass} onClick={() => setSheetOpen(false)}>
                  <Icon name="trash" className="size-3.5" />
                  Delete
                </ThreadListItemPrimitive.Delete>
              ) : null}
            </div>
          </BottomSheet>
        ) : null}
        {folderDialog}
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
          {chatFolders !== null ? (
            <ThreadListItemMorePrimitive.Item className={menuItemClass} onSelect={() => setFolderOpen(true)}>
              <Icon name="folder" className="size-3.5" />
              Move to folder
            </ThreadListItemMorePrimitive.Item>
          ) : null}
          {canDelete ? (
            <ThreadListItemPrimitive.Delete asChild>
              <ThreadListItemMorePrimitive.Item className={deleteItemClass}>
                <Icon name="trash" className="size-3.5" />
                Delete
              </ThreadListItemMorePrimitive.Item>
            </ThreadListItemPrimitive.Delete>
          ) : null}
        </ThreadListItemMorePrimitive.Content>
      </ThreadListItemMorePrimitive.Root>
      {folderDialog}
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
