'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import type { NotesFolderSetupPort, NotesFolderStatus } from '@/server/notesFolderSetup.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

type NotesFolderSetupPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  port: NotesFolderSetupPort;
  /** Called after anything that changes the connection, so the list can refresh. */
  onChanged: () => void;
};

const LABEL_CLASS = 'mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary';

/**
 * The Notes folder card's setup panel: a folder path and the inbox file name, nothing else.
 * There is no account and no secret here. Saving checks the folder first, and the server's own
 * line says why a folder cannot be used. Remove forgets the folder and changes nothing in it.
 */
export default function NotesFolderSetupPanel({ open, onOpenChange, port, onChanged }: NotesFolderSetupPanelProps) {
  const [status, setStatus] = useState<NotesFolderStatus | null>(null);
  const [folderPath, setFolderPath] = useState('');
  const [inboxFile, setInboxFile] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every status, including the one after Remove, sets the whole form, so nothing stale is left behind.
  const applyStatus = useCallback((next: NotesFolderStatus) => {
    setStatus(next);
    setFolderPath(next.folderPath ?? '');
    setInboxFile(next.inboxFile);
    setShowForm(next.state !== 'connected');
    setConfirmingRemove(false);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    let cancelled = false;
    void port
      .getNotesFolderStatus()
      .then(next => {
        if (!cancelled) {
          applyStatus(next);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(getErrorMessage(caught, "Couldn't check your notes folder just now. Try again."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, port, applyStatus]);

  const connected = status?.state === 'connected';
  const saved = status !== null && status.state !== 'not_connected';

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmedInbox = inboxFile.trim();
      applyStatus(
        await port.saveNotesFolder({
          folderPath: folderPath.trim(),
          ...(trimmedInbox === '' ? {} : { inboxFile: trimmedInbox }),
        }),
      );
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught, "Couldn't save that folder. Try again."));
      // A save that was cut off may still have gone through, so the list asks again.
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(await port.removeNotesFolder());
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught, "Couldn't remove that folder. Try again."));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const removeControls = confirmingRemove ? (
    <div className="flex flex-wrap items-center gap-2">
      <p className="w-full text-text-secondary">
        Remove this folder? Your notes are not changed; your assistant just stops looking at them.
      </p>
      <Button type="button" disabled={busy} onClick={() => void handleRemove()}>
        Remove folder
      </Button>
      <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingRemove(false)}>
        Keep it
      </Button>
    </div>
  ) : (
    <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingRemove(true)}>
      Remove
    </Button>
  );

  return (
    <CenteredModal
      open={open}
      onOpenChange={onOpenChange}
      title="Notes folder"
      description="Point your assistant at a folder of Markdown notes, like the vault you open in Obsidian. It can search and read your notes, add entries to one inbox file, and make new notes. It never changes or deletes a note you wrote."
      className="md:max-w-2xl"
    >
      <div className="space-y-5 px-5 py-5 text-sm text-text-primary">
        {error ? (
          <p role="alert" className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg">
            {error}
          </p>
        ) : null}

        {status === null && error === null ? <p className="text-text-secondary">Checking…</p> : null}

        {status !== null && connected && !showForm ? (
          <div className="space-y-4">
            <p>
              Connected to <span className="font-medium">{status.folderPath}</span>.
            </p>
            <p className="text-text-secondary">
              {status.noteCount === null
                ? 'The notes in it can be searched and read.'
                : `It holds ${status.noteCount} ${status.noteCount === 1 ? 'note' : 'notes'}.`}{' '}
              New entries are added to {status.inboxFile}.
            </p>
            {confirmingRemove ? (
              removeControls
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" type="button" onClick={() => setShowForm(true)}>
                  Change folder
                </Button>
                {removeControls}
              </div>
            )}
          </div>
        ) : null}

        {status !== null && (!connected || showForm) ? (
          <form onSubmit={event => void handleSave(event)} className="space-y-4">
            {status.state === 'not_working' ? (
              <p
                role="alert"
                className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg"
              >
                This folder is saved, but your assistant cannot find it right now. Check the folder is still there, or
                type the path again.
              </p>
            ) : null}
            <p className="text-text-secondary">
              {saved
                ? 'Saving replaces the saved folder. The folder is checked before anything is saved.'
                : 'The folder is checked before anything is saved.'}
            </p>
            <p className="text-text-secondary">
              A notes folder works on the npx install and on an install built from the source. The Docker install and
              Aman Setup on Windows cannot use one, because Aman runs in a container there and cannot see your folders.
              On those, connect Obsidian instead: Help, Your notes folder, shows how.
            </p>
            <div>
              <label htmlFor="notes-folder-path" className={LABEL_CLASS}>
                Folder
              </label>
              <input
                id="notes-folder-path"
                className={auiInputClass('h-11')}
                value={folderPath}
                onChange={event => setFolderPath(event.target.value)}
                placeholder="The path of your notes folder, on the computer your assistant runs on"
                autoComplete="off"
              />
              <p className="mt-2 text-text-secondary">
                The folder your notes live in, such as the vault you open in Obsidian. It can be one that a sync app
                like Syncthing or Nextcloud keeps up to date.
              </p>
            </div>
            <div>
              <label htmlFor="notes-folder-inbox" className={LABEL_CLASS}>
                Inbox file
              </label>
              <input
                id="notes-folder-inbox"
                className={auiInputClass('h-11')}
                value={inboxFile}
                onChange={event => setInboxFile(event.target.value)}
                placeholder="Aman inbox.md"
                autoComplete="off"
              />
              <p className="mt-2 text-text-secondary">
                New entries from your assistant are added to this file, under a heading with the date and time. Nothing
                else in your notes is ever changed.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>{saved ? removeControls : null}</div>
              <div className="flex gap-2">
                {saved ? (
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => (connected ? setShowForm(false) : onOpenChange(false))}
                  >
                    Cancel
                  </Button>
                ) : null}
                <Button type="submit" disabled={busy || folderPath.trim() === ''}>
                  {busy ? 'Checking…' : 'Connect'}
                </Button>
              </div>
            </div>
          </form>
        ) : null}
      </div>
    </CenteredModal>
  );
}
