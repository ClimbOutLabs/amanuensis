import type { AclRead, WindowsJobs } from '../host/windowsJobs.ts';
import {
  FILES_COULD_NOT_CHECK,
  FILES_COULD_NOT_FIX,
  FILES_MADE_PRIVATE_LINE,
  FILES_NOT_PRIVATE,
  FILES_PRIVATE_LINE,
} from '../messages.ts';
import type { CheckList, DoctorDeps } from './doctor.ts';

// The files check, Windows only: the folders Aman keeps on the PC
// itself must be readable by the person's own account only. It is this
// doctor's own check, not one of the shell doctor's machine checks:
// the shell keeps what is inside the Docker volume private with file
// modes, and this is the same promise for the Windows disk. The check
// runs only in the doctor a person runs (Check Aman), never in the
// local gate an upgrade judges by.

// The folders the check covers: the one folder on the Windows disk
// where Aman keeps its own files. What later stages put on the Windows
// disk (the daily backups) lives inside it, and the access set there
// is inherited by the folders and files made inside.
function secretFolders(jobs: WindowsJobs): readonly string[] {
  return [jobs.dataDir];
}

type FolderState = 'private' | 'open' | 'missing' | 'unreadable';

// One folder judged from its access list: private when no account but
// the person's own can read what is in it.
async function folderState(jobs: WindowsJobs, path: string): Promise<FolderState> {
  let read: AclRead;
  try {
    read = await jobs.readFolderAcl(path);
  } catch {
    return 'unreadable';
  }
  if (read.status !== 'read') {
    return read.status;
  }
  const owner = read.owner.toLowerCase();
  const opened = read.entries.some(entry => entry.canRead && entry.principal.toLowerCase() !== owner);
  return opened ? 'open' : 'private';
}

export async function checkSecretFiles(deps: DoctorDeps, list: CheckList, options: { fix: boolean }): Promise<void> {
  const jobs = deps.windowsJobs;
  if (deps.host.kind !== 'windows' || jobs === undefined) {
    return;
  }
  const folders = secretFolders(jobs);
  const states = new Map<string, FolderState>();
  for (const folder of folders) {
    states.set(folder, await folderState(jobs, folder));
  }
  const present = folders.filter(folder => states.get(folder) !== 'missing');
  if (present.length === 0) {
    // Nothing on the Windows disk yet, so nothing to judge.
    return;
  }
  if (present.some(folder => states.get(folder) === 'unreadable')) {
    list.record({
      scope: 'machine',
      id: 'files',
      state: 'fail',
      detail: FILES_COULD_NOT_CHECK.happened,
      fix: FILES_COULD_NOT_CHECK.fix,
    });
    return;
  }
  const open = present.filter(folder => states.get(folder) === 'open');
  if (open.length === 0) {
    list.record({ scope: 'machine', id: 'files', state: 'ok', detail: FILES_PRIVATE_LINE, fix: '' });
    return;
  }
  if (!options.fix) {
    list.record({
      scope: 'machine',
      id: 'files',
      state: 'fail',
      detail: FILES_NOT_PRIVATE.happened,
      fix: FILES_NOT_PRIVATE.fix,
    });
    return;
  }
  // The fix this check's own line promises, and no other check's: make
  // the open folders private, then read them back to be sure it held.
  let applied = true;
  for (const folder of open) {
    try {
      await jobs.makeFolderPrivate(folder);
    } catch {
      applied = false;
    }
  }
  let confirmed = applied;
  if (confirmed) {
    for (const folder of present) {
      if ((await folderState(jobs, folder)) !== 'private') {
        confirmed = false;
      }
    }
  }
  if (!confirmed) {
    list.record({
      scope: 'machine',
      id: 'files',
      state: 'fail',
      detail: FILES_COULD_NOT_FIX.happened,
      fix: FILES_COULD_NOT_FIX.fix,
    });
    return;
  }
  list.record({ scope: 'machine', id: 'files', state: 'ok', detail: FILES_MADE_PRIVATE_LINE, fix: '' });
}
