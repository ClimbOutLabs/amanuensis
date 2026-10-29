import type { SystemKind } from './host/host.ts';
import { LOCK_TIMING } from './state/lockTiming.ts';

// Every sentence a person can read lives in this file, as a Problem with two
// fields: what happened, and what to do (one sentence, one action). A test in
// tests/messages.test.ts fails the build when a message breaks the rules in
// the plan: plain words, no jargon, at most 40 words, one action.
export interface Problem {
  happened: string;
  fix: string;
}

export function problemText(problem: Problem): string {
  return `${problem.happened} ${problem.fix}`;
}

export function versionLine(version: string): string {
  return `aman ${version}`;
}

export const HELP_LINES: readonly string[] = [
  'Aman installer. It sets up Aman on this computer and checks that things work.',
  'Run aman --version to see which version this is.',
  'Run aman doctor to check this computer and each instance.',
  'Run aman doctor docker to check that Docker is ready for Aman.',
  'Run aman status to see what is installed and whether it is running.',
  'Run aman install to set up Aman on this computer for the first time.',
  'Run aman adopt to move a PC set up with Aman Setup onto the aman command.',
  'Run aman open to open Aman in your browser.',
  'Run aman network open to open Aman to phones and other devices on your home network.',
  'Run aman network close to close Aman to your home network again.',
  'Run aman upgrade to update Aman on Windows to the newest version.',
  'Run aman backup to make a backup of Aman now, in the Backups folder on this computer.',
  'Run aman backups to list the backups kept on this computer.',
  'Run aman verify and name a downloaded file to check it against its signed release record.',
];

export const DOCKER_NOT_INSTALLED: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker is not installed on this computer.',
    fix: 'Install Docker Desktop from its website, then run this check again.',
  },
  darwin: {
    happened: 'Docker is not installed on this computer.',
    fix: 'Install Docker Desktop from its website, then run this check again.',
  },
  linux: {
    happened: 'Docker is not installed on this computer.',
    fix: 'Install Docker Engine from its website, then run this check again.',
  },
};

export const DOCKER_NOT_RUNNING: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker Desktop is not running.',
    fix: 'Open Docker Desktop from the Start menu, then run this check again.',
  },
  darwin: {
    happened: 'Docker Desktop is not running.',
    fix: 'Open Docker Desktop from Launchpad, then run this check again.',
  },
  linux: {
    happened: 'Docker Engine is not running.',
    fix: 'Start Docker Engine on this computer, then run this check again.',
  },
};

export const COMPOSE_MISSING: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker is installed without its Compose tool, which Aman needs.',
    fix: 'Update Docker Desktop to the newest version, then run this check again.',
  },
  darwin: {
    happened: 'Docker is installed without its Compose tool, which Aman needs.',
    fix: 'Update Docker Desktop to the newest version, then run this check again.',
  },
  linux: {
    happened: 'Docker is installed without its Compose tool, which Aman needs.',
    fix: 'Install the Docker Compose add-on, then run this check again.',
  },
};

export const LOW_MEMORY: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker has less than 6 GB of memory to work with on this computer.',
    fix: 'Open Docker Desktop, choose Settings, then Resources, give it at least 6 GB, then run this check again.',
  },
  darwin: {
    happened: 'Docker has less than 6 GB of memory to work with on this computer.',
    fix: 'Give Docker Desktop at least 6 GB of memory in its settings, then run this check again.',
  },
  linux: {
    happened: 'This computer gives Docker Engine less than 6 GB of memory to work with.',
    fix: 'Free up memory on this computer so Docker Engine can use at least 6 GB, then run this check again.',
  },
};

// Said when Docker does not report its memory at all. On Windows and Mac
// the check fails with this instead of guessing from the whole computer's
// memory, which is not the memory Docker can use.
export const MEMORY_NOT_REPORTED: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker did not say how much memory it has to work with.',
    fix: 'Open Docker Desktop, choose Settings, then Resources, set the memory to at least 6 GB, then run this check again.',
  },
  darwin: {
    happened: 'Docker did not say how much memory it has to work with.',
    fix: 'Open Docker Desktop, check the memory in its settings, then run this check again.',
  },
  linux: {
    happened: 'Docker did not say how much memory it has to work with.',
    fix: 'Start Docker Engine again, then run this check again.',
  },
};

export const ENGINE_VERSION_MISSING: Problem = {
  happened: 'Docker did not say which Engine version it is running.',
  fix: 'Update Docker to the newest version, then run this check again.',
};

// The Engine floor for the way the https folders are mounted on a
// Windows PC, from inside the volume the state lives in: an older
// Engine cannot mount one folder inside a volume at all.
export const ENGINE_TOO_OLD: Record<SystemKind, Problem> = {
  windows: {
    happened: "Docker Desktop is running an Engine that is too old for Aman's https on this computer.",
    fix: 'Update Docker Desktop to the newest version, then run this check again.',
  },
  darwin: {
    happened: "Docker Desktop is running an Engine that is too old for Aman's https on this computer.",
    fix: 'Update Docker Desktop to the newest version, then run this check again.',
  },
  linux: {
    happened: "Docker Engine is too old for Aman's https on this computer.",
    fix: 'Update Docker Engine to the newest version, then run this check again.',
  },
};

export function unknownCommandProblem(command: string): Problem {
  return {
    happened: `Aman does not know the command "${command}".`,
    fix: 'Run aman with no command to see what it can do.',
  };
}

export const UNKNOWN_DOCTOR_CHECK: Problem = {
  happened: 'That doctor check is not one Aman knows.',
  fix: 'Run aman doctor docker to check Docker on this computer.',
};

export function dockerInstalledLine(version: string): string {
  return `Docker is installed, version ${version}.`;
}

export function dockerRunningLine(engineVersion: string): string {
  return `Docker is running, Engine version ${engineVersion}.`;
}

export function composeReadyLine(version: string): string {
  return `Docker Compose is ready, version ${version}.`;
}

export function memoryReadyLine(sizeText: string): string {
  return `Docker has ${sizeText} of memory to work with, which is enough.`;
}

export const ALL_READY_LINE = 'Docker is ready for Aman on this computer.';

export const NOT_INSTALLED: Problem = {
  happened: 'Aman is not installed on this computer yet.',
  fix: 'Install Aman on this computer, then run aman status again.',
};

export const STATE_UNREADABLE: Problem = {
  happened: 'The record of what is installed could not be read.',
  fix: 'Run the installer again from the folder Aman was installed from, then run aman status again.',
};

// The wait is the lock's dead limit: an install stopped without cleaning up
// leaves its lock until its beats have been missing that long.
export const STATE_BUSY: Problem = {
  happened: 'Another install is running right now.',
  fix: `Wait for it to finish, or wait ${String(LOCK_TIMING.deadSeconds / 60)} minutes if you stopped an install a moment ago, then run aman status again.`,
};

export const STATE_IMAGE_UNAVAILABLE: Problem = {
  happened: 'Docker could not download the small helper it needs to read the record of what is installed.',
  fix: 'Check your internet connection, then run aman status again.',
};

export const DOCKER_NOT_ANSWERING: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker is not answering, so whether each instance is running is unknown.',
    fix: 'Open Docker Desktop from the Start menu, then run aman status again.',
  },
  darwin: {
    happened: 'Docker is not answering, so whether each instance is running is unknown.',
    fix: 'Open Docker Desktop from Launchpad, then run aman status again.',
  },
  linux: {
    happened: 'Docker is not answering, so whether each instance is running is unknown.',
    fix: 'Start Docker Engine on this computer, then run aman status again.',
  },
};

// The name and the address come from files in the state home, so a control
// character in them must not reach the screen as a terminal command.
function printable(text: string): string {
  return text.replace(/\p{Cc}/gu, '');
}

export function statusInstalledLine(version: string): string {
  return `Aman is installed, version ${printable(version)}.`;
}

export type InstanceState = 'running' | 'partly running' | 'stopped' | 'unknown';

export function statusInstanceLine(name: string, state: InstanceState, address: string | null): string {
  if (state === 'unknown') {
    return `Instance ${printable(name)}: whether it is running is unknown.`;
  }
  if (address === null) {
    return `Instance ${printable(name)} is ${state}.`;
  }
  return `Instance ${printable(name)} is ${state} at ${printable(address)}.`;
}

export const NO_INSTANCES_LINE = 'No instance has been made yet.';

// The line the plan gives the adopt moment: the install was already on
// the PC, the upgrade that led here updated it, and nothing was lost.
export const ADOPTED_LINE = 'Aman is already on this PC. It is updated, and your chats are kept.';

export const ADOPT_NOT_WINDOWS: Problem = {
  happened: 'This computer was not set up with the Aman Setup download, so there is nothing to adopt.',
  fix: 'Run aman status to see what is installed on this computer.',
};

export const ADOPT_NOT_INSTALLED: Problem = {
  happened: 'Aman is not installed on this computer yet.',
  fix: 'Install Aman with the Aman Setup download first, then run aman adopt again.',
};

export const ADOPT_DOCKER_NOT_ANSWERING: Problem = {
  happened: 'Docker is not answering, so the record of what is installed could not be read.',
  fix: 'Open Docker Desktop from the Start menu, then run aman adopt again.',
};

export const ADOPT_IMAGE_UNAVAILABLE: Problem = {
  happened: 'Docker could not download the small helper it needs to read the record of what is installed.',
  fix: 'Check your internet connection, then run aman adopt again.',
};

export const ADOPT_STATE_UNREADABLE: Problem = {
  happened: 'The record of what is installed could not be read.',
  fix: 'Run aman doctor to find what is wrong, then run aman adopt again.',
};

// The same wait the state lock asks for, with this command's own next
// step: the lock's dead limit, as in STATE_BUSY.
export const ADOPT_BUSY: Problem = {
  happened: 'Another install is running right now.',
  fix: `Wait for it to finish, or wait ${String(LOCK_TIMING.deadSeconds / 60)} minutes if you stopped an install a moment ago, then run aman adopt again.`,
};

export const ADOPT_SETUP_FAILED: Problem = {
  happened: 'Aman could not finish moving this install onto the aman command.',
  fix: 'Run aman adopt again, and if it fails again, run aman doctor.',
};

export const OPEN_NOT_WINDOWS: Problem = {
  happened: 'This computer was not set up with the Aman Setup download, so aman open has nothing to open.',
  fix: 'Run aman status to see what is installed on this computer.',
};

export const OPEN_NOT_INSTALLED: Problem = {
  happened: 'Aman is not installed on this computer yet.',
  fix: 'Install Aman with the Aman Setup download first, then run aman open again.',
};

export const OPEN_DOCKER_MISSING: Problem = {
  happened: 'Docker Desktop is not installed on this computer.',
  fix: 'Install Docker Desktop from its website, then run aman open again.',
};

export const OPEN_DOCKER_DID_NOT_START: Problem = {
  happened: 'Docker Desktop did not start.',
  fix: 'Open Docker Desktop from the Start menu, wait until it says it is running, then run aman open again.',
};

export const OPEN_IMAGE_UNAVAILABLE: Problem = {
  happened: 'Docker could not download the small helper it needs to read the record of what is installed.',
  fix: 'Check your internet connection, then run aman open again.',
};

export const OPEN_STATE_UNREADABLE: Problem = {
  happened: 'The record of what is installed could not be read.',
  fix: 'Run aman doctor to find what is wrong, then run aman open again.',
};

export const OPEN_ADDRESS_MISSING: Problem = {
  happened: 'The record of what is installed does not say where Aman answers on this computer.',
  fix: 'Run aman doctor to find what is wrong, then run aman open again.',
};

export const OPEN_DID_NOT_ANSWER: Problem = {
  happened: 'Aman did not start answering on this computer.',
  fix: 'Run aman doctor to find what is wrong, then run aman open again.',
};

export const OPEN_CERT_MISSING: Problem = {
  happened: 'The certificate that lets your browser trust Aman at its https address could not be found.',
  fix: 'Run aman doctor to find what is wrong, then run aman open again.',
};

export const OPEN_TRUST_FAILED: Problem = {
  happened:
    "This computer could not be set to trust Aman's certificate, so the browser would show a warning at the https address.",
  fix: 'Run aman open again, and choose Yes when Windows asks whether to trust the certificate.',
};

export function openReadyLine(address: string): string {
  return `Aman is open in your browser at ${printable(address)}.`;
}

export function openBrowserFailedProblem(address: string): Problem {
  return {
    happened: 'Aman is running, but the browser did not open on its own.',
    fix: `Open your browser and go to ${printable(address)} to use Aman.`,
  };
}

export const VERIFY_USAGE: Problem = {
  happened: 'aman verify needs the name of the downloaded file to check.',
  fix: 'Run aman verify again and name the file you downloaded from the release page.',
};

export const VERIFY_MANIFEST_MISSING: Problem = {
  happened: 'The release record that goes with this download is missing.',
  fix: 'Download manifest.json from the same release page into the same folder, then run aman verify again.',
};

export const VERIFY_SIGNATURE_MISSING: Problem = {
  happened: 'The signature that goes with this release record is missing.',
  fix: 'Download manifest.json.minisig from the same release page into the same folder, then run aman verify again.',
};

export const VERIFY_MANIFEST_UNREADABLE: Problem = {
  happened: 'The release record could not be read.',
  fix: 'Download manifest.json again from the Aman release page, then run aman verify again.',
};

export const VERIFY_SIGNATURE_BAD: Problem = {
  happened: 'The signature on this release record does not check out.',
  fix: 'Download the release files again from the Aman release page, then run aman verify again.',
};

export const VERIFY_DOWNLOAD_UNREADABLE: Problem = {
  happened: 'The downloaded file could not be read.',
  fix: 'Download it again from the Aman release page, then run aman verify again.',
};

export function verifyNotListedProblem(fileName: string): Problem {
  return {
    happened: `The download ${printable(fileName)} is not in the release record.`,
    fix: 'Check the name against the files on the Aman release page, then run aman verify again.',
  };
}

export function verifyChangedProblem(fileName: string): Problem {
  return {
    happened: `The download ${printable(fileName)} does not match the release record.`,
    fix: 'Download it again from the Aman release page, then run aman verify again.',
  };
}

export const VERIFY_SOURCE_IDS_MISMATCH: Problem = {
  happened: 'The image names in the release record do not match this copy of the Aman code.',
  fix: 'Make the release record again from a clean copy of the release, then check it again.',
};

export function verifyOkLine(fileName: string): string {
  return `${printable(fileName)} matches the signed release record.`;
}

export const UPGRADE_NOT_WINDOWS: Problem = {
  happened: 'Aman cannot update itself from here on this computer.',
  fix: 'Update Aman with the installer command, the way you installed it.',
};

export const UPGRADE_PROGRAM_MISSING: Problem = {
  happened: 'Aman is installed, but its program is not in place on this computer.',
  fix: 'Run Aman Setup once to put the program in place, then run Update Aman again.',
};

export const UPGRADE_SOURCE_MISSING: Problem = {
  happened: 'This release does not carry the source files the update needs.',
  fix: 'Run Update Aman from the Start menu again later, when a fixed release is out.',
};

export const UPGRADE_DOWNLOAD_FAILED: Problem = {
  happened: 'The newest version of Aman could not be downloaded.',
  fix: 'Check your internet connection, then run Update Aman from the Start menu again.',
};

// The fix sentence is the doctor's own, for the first check that failed:
// the gate refuses in the doctor's words, not a second set of words.
export function upgradeNotReadyProblem(doctorFix: string): Problem {
  const fix = doctorFix.replace(/\.+$/, '');
  return {
    happened: 'Aman is not ready to update.',
    fix: fix === '' ? 'Run aman doctor to see what needs fixing.' : `${fix}.`,
  };
}

export const UPGRADE_SMOKE_FAILED: Problem = {
  happened: 'The new version of Aman did not start, so the update was stopped and your Aman is unchanged.',
  fix: 'Run Update Aman from the Start menu again later.',
};

export const UPGRADE_REPLACE_FAILED: Problem = {
  happened: 'The new Aman program could not be put in place.',
  fix: 'Close any Aman window that is open, then run Update Aman from the Start menu again.',
};

// The swap's last step: the checked new program could not be renamed
// over the old one, the old one is back in place, and the new one stays
// in the program folder under its staging name, where the next upgrade
// writes over it.
export const UPGRADE_NEW_PROGRAM_WAITING: Problem = {
  happened:
    'The new Aman program passed its checks but could not be moved into place, so it stays in the Aman program folder as aman.exe.new and your Aman is unchanged.',
  fix: 'Run Update Aman from the Start menu again.',
};

// The worse end of the same step: the old program could not be put back
// either. The kept old copy is still in the folder, and the first step
// of every start puts it back, which is the fix this problem names.
export const UPGRADE_OLD_PROGRAM_NOT_BACK: Problem = {
  happened: 'The new Aman program could not be moved into place, and the old program could not be put back.',
  fix: 'Run the Aman Setup file again, and its first step will put the old program back.',
};

export const UPGRADE_SOURCE_FAILED: Problem = {
  happened: 'The new Aman program is in place, but the update itself did not finish.',
  fix: 'Run Update Aman from the Start menu again to finish the update.',
};

export const UPGRADE_DOCKER_NOT_ANSWERING: Problem = {
  happened: 'Docker is not answering, so the update cannot go ahead.',
  fix: 'Open Docker Desktop from the Start menu, then run Update Aman again.',
};

// The same wait the state lock asks for, with this command's own next
// step: the lock's dead limit, as in STATE_BUSY.
export const UPGRADE_BUSY: Problem = {
  happened: 'Another install is running right now.',
  fix: `Wait for it to finish, or wait ${String(LOCK_TIMING.deadSeconds / 60)} minutes if you stopped an install a moment ago, then run Update Aman from the Start menu again.`,
};

export const UPGRADE_ROLLED_BACK: Problem = {
  happened: 'The update did not work, so the previous version of Aman was put back.',
  fix: 'Run Check Aman from the Start menu to see what needs fixing.',
};

export const UPGRADE_NOT_PUT_BACK: Problem = {
  happened: 'The update did not work, and the previous version could not be fully put back.',
  fix: 'Run Check Aman from the Start menu to see how things stand.',
};

export const UPGRADE_CONTAINER_FAILED: Problem = {
  happened: 'The update stopped before it finished.',
  fix: 'Run Check Aman from the Start menu to see how things stand.',
};

export function upgradeQuestionLine(release: string): string {
  return `A newer Aman, ${printable(release)}, is ready. Update to it now?`;
}

export const UPGRADE_DECLINED_LINE = 'Nothing was updated.';

export const UPGRADE_UP_TO_DATE_LINE = 'Aman is already up to date.';

export const UPGRADE_EXE_IN_PLACE_LINE = 'The new Aman program is in place; it runs the next time Aman starts.';

export function upgradeDoneLine(release: string): string {
  return `Aman is updated to ${printable(release)}.`;
}

export const BACKUP_NOT_WINDOWS: Problem = {
  happened: 'This computer was not set up with the Aman Setup download, so aman backup has nothing to back up.',
  fix: 'Run aman status to see what is installed on this computer.',
};

export const BACKUP_NOT_INSTALLED: Problem = {
  happened: 'Aman is not installed on this computer yet.',
  fix: 'Install Aman with the Aman Setup download first, then run aman backup again.',
};

export const BACKUP_DOCKER_NOT_ANSWERING: Problem = {
  happened: 'Docker is not answering, so the backup cannot be made.',
  fix: 'Open Docker Desktop from the Start menu, then run aman backup again.',
};

export const BACKUP_IMAGE_UNAVAILABLE: Problem = {
  happened: 'Docker could not download the small helper it needs to make the backup.',
  fix: 'Check your internet connection, then run aman backup again.',
};

export const BACKUP_STATE_UNREADABLE: Problem = {
  happened: 'The record of what is installed could not be read.',
  fix: 'Run aman doctor to find what is wrong, then run aman backup again.',
};

// The same wait the state lock asks for, with this command's own next
// step: the lock's dead limit, as in STATE_BUSY.
export const BACKUP_BUSY: Problem = {
  happened: 'Another install is running right now.',
  fix: `Wait for it to finish, or wait ${String(LOCK_TIMING.deadSeconds / 60)} minutes if you stopped an install a moment ago, then run aman backup again.`,
};

export const BACKUP_FAILED: Problem = {
  happened: 'The backup did not finish, so nothing new was saved.',
  fix: 'Run aman doctor to find what is wrong, then run aman backup again.',
};

export const BACKUP_SAVED_LINE = 'Open the Backups entry in the Start menu to see the backup.';

export const BACKUPS_NOT_WINDOWS: Problem = {
  happened: 'This computer was not set up with the Aman Setup download, so it keeps no backups to list.',
  fix: 'Run aman status to see what is installed on this computer.',
};

export const BACKUPS_COULD_NOT_LIST: Problem = {
  happened: 'The backups kept on this computer could not be listed.',
  fix: 'Run aman doctor to find what is wrong, then run aman backups again.',
};

export const NO_BACKUPS_LINE = 'No backups have been made on this computer yet.';

export function backupsFolderLine(folder: string): string {
  return `Backups are kept in the folder ${printable(folder)}.`;
}

export function backupNameLine(name: string): string {
  return printable(name);
}

// The doctor's files check on Windows: the folders Aman keeps on the
// PC itself must be readable by the person's own account only.
export const FILES_PRIVATE_LINE = 'The files Aman keeps on this computer are private to you.';

export const FILES_MADE_PRIVATE_LINE = 'The files Aman keeps on this computer are now private to you.';

export const FILES_NOT_PRIVATE: Problem = {
  happened: 'Files Aman keeps on this computer can be read by other accounts on this computer.',
  fix: 'Run Check Aman again with Fix; it makes these files private to you.',
};

export const FILES_COULD_NOT_FIX: Problem = {
  happened: 'Aman could not make these files private to you.',
  fix: 'Run Check Aman again with Fix.',
};

export const FILES_COULD_NOT_CHECK: Problem = {
  happened: 'Whether the files Aman keeps on this computer are private could not be checked.',
  fix: 'Run aman doctor again.',
};

export const NETWORK_USAGE: Problem = {
  happened: 'aman network needs the word open or the word close after it.',
  fix: 'Run aman network open to open Aman to your home network, or aman network close to close it.',
};

export const NETWORK_NOT_WINDOWS: Problem = {
  happened: 'This computer was not set up with the Aman Setup download, so aman network has nothing to change.',
  fix: 'Run aman status to see what is installed on this computer.',
};

export const NETWORK_NOT_INSTALLED: Problem = {
  happened: 'Aman is not installed on this computer yet.',
  fix: 'Install Aman with the Aman Setup download first, then run aman network open again.',
};

export const NETWORK_IMAGE_UNAVAILABLE: Problem = {
  happened: 'Docker could not download the small helper it needs to read the record of what is installed.',
  fix: 'Check your internet connection, then run the command again.',
};

export const NETWORK_STATE_UNREADABLE: Problem = {
  happened: 'The record of what is installed could not be read.',
  fix: 'Run aman doctor to find what is wrong, then run the command again.',
};

export const NETWORK_ADDRESS_MISSING: Problem = {
  happened: 'The record of what is installed does not say where Aman answers on this computer.',
  fix: 'Run aman doctor to find what is wrong, then run the command again.',
};

export const NETWORK_NO_ADDRESS: Problem = {
  happened: 'This computer has no address on a private network that a phone could use.',
  fix: 'Connect this computer to your home Wi-Fi, then run aman network open again.',
};

export const NETWORK_DOCKER_NOT_ANSWERING: Problem = {
  happened: 'Docker is not answering, so the change cannot be made.',
  fix: 'Open Docker Desktop from the Start menu, then run the command again.',
};

export const NETWORK_BUSY: Problem = {
  happened: 'Another install is running right now.',
  fix: `Wait for it to finish, or wait ${String(LOCK_TIMING.deadSeconds / 60)} minutes if you stopped an install a moment ago, then run the command again.`,
};

export const NETWORK_OPEN_FAILED: Problem = {
  happened: 'Aman could not be opened to the devices on your home network.',
  fix: 'Run aman doctor to find what is wrong, then run aman network open again.',
};

export const NETWORK_CLOSE_FAILED: Problem = {
  happened: 'Aman could not be closed to the devices on your home network.',
  fix: 'Run aman doctor to find what is wrong, then run aman network close again.',
};

export const NETWORK_FIREWALL_OPEN_FAILED: Problem = {
  happened: 'Windows did not change the firewall rule, so devices on your home network cannot reach Aman yet.',
  fix: 'Run aman network open again, and choose Yes when Windows asks for permission.',
};

export const NETWORK_FIREWALL_CLOSE_FAILED: Problem = {
  happened: 'Windows did not change the firewall rule, so devices on your home network can still reach Aman.',
  fix: 'Run aman network close again, and choose Yes when Windows asks for permission.',
};

export const NETWORK_OPEN_LINE = 'Aman is open to the devices on your home network.';

export const NETWORK_CLOSED_LINE = 'Aman is closed to your home network, and only this computer can open it now.';

export function networkPhoneLine(address: string): string {
  return `On your phone, open ${printable(address)}.`;
}

export const INSTALL_NOT_WINDOWS: Problem = {
  happened: 'The Aman Setup download sets Aman up on a Windows computer, and this is not one.',
  fix: 'Use the installer for this computer to set Aman up.',
};

export const INSTALL_IMAGE_UNAVAILABLE: Problem = {
  happened: 'Docker could not download the small helper it needs to read the record of what is installed.',
  fix: 'Check your internet connection, then open Aman Setup again.',
};

export const INSTALL_DOWNLOAD_FAILED: Problem = {
  happened: 'Docker Desktop could not be downloaded.',
  fix: 'Check your internet connection, then open Aman Setup again.',
};

export const INSTALL_DOCKER_UNTRUSTED: Problem = {
  happened: 'The Docker Desktop download did not come from Docker Inc, so it was not run.',
  fix: 'Download Docker Desktop from desktop.docker.com yourself, then open Aman Setup again.',
};

export const INSTALL_DOCKER_FAILED: Problem = {
  happened: 'Docker Desktop could not be installed.',
  fix: 'Install Docker Desktop from its website, then open Aman Setup again.',
};

export const INSTALL_DOCKER_DID_NOT_START: Problem = {
  happened: 'Docker Desktop did not start.',
  fix: 'Open Docker Desktop from the Start menu, wait until it says it is running, then open Aman Setup again.',
};

// The restart Docker Desktop asks for after it is installed: the setup
// is set to open again by itself once the computer is back, and carries
// on from this point.
export const INSTALL_RESTART_NEEDED: Problem = {
  happened: 'Docker Desktop needs your computer to restart before it can run.',
  fix: 'Restart your computer, and Aman Setup will open again by itself and carry on.',
};

export const INSTALL_DOCKER_NOT_ANSWERING: Problem = {
  happened: 'Docker is not answering, so the setup cannot go ahead.',
  fix: 'Open Docker Desktop from the Start menu, then open Aman Setup again.',
};

export const INSTALL_NO_ANSWER: Problem = {
  happened: 'No answer was given, so nothing was installed.',
  fix: 'Open Aman Setup again when you are ready to answer its questions.',
};

export const INSTALL_NO_FREE_PORT: Problem = {
  happened: 'Every place Aman could answer on this computer is taken by another program.',
  fix: 'Stop a program you do not need, then open Aman Setup again.',
};

export const INSTALL_RELEASE_DOWNLOAD_FAILED: Problem = {
  happened: 'The newest version of Aman could not be downloaded.',
  fix: 'Check your internet connection, then open Aman Setup again.',
};

export const INSTALL_SOURCE_MISSING: Problem = {
  happened: 'This release does not carry the source files the setup needs.',
  fix: 'Open Aman Setup again later, when a fixed release is out.',
};

export const INSTALL_SOURCE_FAILED: Problem = {
  happened: 'Aman could not be set up from the downloaded files.',
  fix: 'Open Aman Setup again.',
};

// The same wait the state lock asks for, with this command's own next
// step: the lock's dead limit, as in STATE_BUSY.
export const INSTALL_BUSY: Problem = {
  happened: 'Another install is running right now.',
  fix: `Wait for it to finish, or wait ${String(LOCK_TIMING.deadSeconds / 60)} minutes if you stopped an install a moment ago, then open Aman Setup again.`,
};

export const INSTALL_CONTAINER_FAILED: Problem = {
  happened: 'The setup stopped before it finished.',
  fix: 'Open Aman Setup again; it carries on from where it stopped.',
};

export const INSTALL_PAGE_FAILED: Problem = {
  happened: 'Aman is installed, but the getting started page could not be opened.',
  fix: 'Open Aman from the Start menu; everything the page names is in Settings.',
};

// The model key is refused on the command line, the way the shell
// installer refuses it: a key typed there would stay in the terminal's
// history and in the list of running programs.
export const INSTALL_KEY_ON_COMMAND_LINE: Problem = {
  happened: 'The model key is never taken from the command line.',
  fix: 'Run aman install again and paste the key when it asks.',
};

export function installUsageProblem(word: string): Problem {
  return {
    happened: `aman install does not take the word "${printable(word)}".`,
    fix: 'Run aman install on its own, or with --dry-run to see what it would do.',
  };
}

// Said at the start of a run the computer restarted in the middle of:
// the setup was set to open again by itself, and it carries on.
export const INSTALL_CONTINUING_LINE = 'Continuing where it left off.';

export const INSTALL_EMAIL_QUESTION = 'Your email, used to sign in:';

export const INSTALL_PASSWORD_QUESTION = 'Choose a password (at least 8 characters, not shown):';

export const INSTALL_PASSWORD_AGAIN_QUESTION = 'Type it again:';

export const INSTALL_PASSWORD_MISMATCH_LINE = 'The passwords do not match. Type them again.';

export const INSTALL_PASSWORD_TOO_LONG_LINE =
  'The password can have at most 72 characters. Accented or non-Latin letters count as more than one.';

// The password rule is the shell installer's own (password_problem in
// installer/lib/common.sh): the setup judges a password by the same
// words here, at the question, instead of letting the build fail on it
// later. The sentence is the shell's, built from what is missing.
export function installPasswordProblem(password: string): string | null {
  if (new TextEncoder().encode(password).length > 72) {
    return INSTALL_PASSWORD_TOO_LONG_LINE;
  }
  const missing: string[] = [];
  if (password.length < 8) {
    missing.push('at least 8 characters');
  }
  if (!/\d/.test(password)) {
    missing.push('a number');
  }
  if (!/[!-/:-@[-`{-~]/.test(password)) {
    missing.push('a symbol, like @ # $ %');
  }
  if (missing.length === 0) {
    return null;
  }
  if (missing.length === 1) {
    return `That password still needs ${missing[0] ?? ''}.`;
  }
  if (missing.length === 2) {
    return `That password still needs ${missing[0] ?? ''} and ${missing[1] ?? ''}.`;
  }
  return `That password still needs ${missing[0] ?? ''}, ${missing[1] ?? ''} and ${missing[2] ?? ''}.`;
}

// What is printed above the model key question: what the key is for,
// and where to get one. The address is Nebius Token Factory's own.
export const INSTALL_KEY_HELP_LINES: readonly string[] = [
  'The key lets Aman answer you with a model from Nebius Token Factory.',
  'Get a key at tokenfactory.nebius.com.',
];

export const INSTALL_KEY_QUESTION = 'Paste your model key (not shown):';

// Said when the key answer is empty, which is allowed: the install
// goes ahead without a key, and Aman opens but cannot answer.
export const INSTALL_KEY_EMPTY_LINE = 'Aman will open but cannot answer until you add a key in Settings, then Models.';

export const INSTALL_PHONE_QUESTION =
  'Also use Aman from your phone and other devices on your home Wi-Fi? (yes or no):';

export const INSTALL_YES_OR_NO_LINE = 'Please answer yes or no.';

export const INSTALL_DONE_LINE = 'Aman is installed, and the getting started page is open in your browser.';

// What aman install --dry-run prints: the steps it would take, in
// order. It asks nothing, downloads nothing and changes nothing.
export const INSTALL_DRY_RUN_LINES: readonly string[] = [
  'This shows what aman install would do. Nothing is changed and nothing is asked.',
  'It checks that Docker Desktop is installed and running, and installs it first if it is missing.',
  'It asks four questions: your email, a password, your model key, and whether to open Aman to your phone.',
  'It downloads the newest Aman and sets it up with daily backups and an https address on this computer.',
  'It puts the aman command and the Start menu entries in place, and opens Aman in your browser.',
  'It opens a short getting started page in your browser at the end.',
];

// Every message, in a fixed order, for the golden file reviewers read.
export function allMessageLines(): string[] {
  const lines: string[] = [versionLine('0.0.0'), ...HELP_LINES];
  const kinds: SystemKind[] = ['windows', 'darwin', 'linux'];
  for (const kind of kinds) {
    lines.push(problemText(DOCKER_NOT_INSTALLED[kind]));
    lines.push(problemText(DOCKER_NOT_RUNNING[kind]));
    lines.push(problemText(COMPOSE_MISSING[kind]));
    lines.push(problemText(LOW_MEMORY[kind]));
    lines.push(problemText(MEMORY_NOT_REPORTED[kind]));
    lines.push(problemText(DOCKER_NOT_ANSWERING[kind]));
  }
  lines.push(problemText(ENGINE_VERSION_MISSING));
  lines.push(problemText(ENGINE_TOO_OLD.windows));
  lines.push(problemText(ENGINE_TOO_OLD.darwin));
  lines.push(problemText(ENGINE_TOO_OLD.linux));
  lines.push(problemText(unknownCommandProblem('example')));
  lines.push(problemText(UNKNOWN_DOCTOR_CHECK));
  lines.push(dockerInstalledLine('0.0.0'));
  lines.push(dockerRunningLine('0.0.0'));
  lines.push(composeReadyLine('0.0.0'));
  lines.push(memoryReadyLine('0 GB'));
  lines.push(ALL_READY_LINE);
  lines.push(problemText(NOT_INSTALLED));
  lines.push(problemText(STATE_UNREADABLE));
  lines.push(problemText(STATE_BUSY));
  lines.push(problemText(STATE_IMAGE_UNAVAILABLE));
  lines.push(statusInstalledLine('aman-app:0'));
  lines.push(statusInstanceLine('main', 'running', 'http://127.0.0.1:8791'));
  lines.push(statusInstanceLine('main', 'partly running', 'http://127.0.0.1:8791'));
  lines.push(statusInstanceLine('main', 'stopped', null));
  lines.push(statusInstanceLine('main', 'unknown', null));
  lines.push(NO_INSTANCES_LINE);
  lines.push(ADOPTED_LINE);
  lines.push(problemText(ADOPT_NOT_WINDOWS));
  lines.push(problemText(ADOPT_NOT_INSTALLED));
  lines.push(problemText(ADOPT_DOCKER_NOT_ANSWERING));
  lines.push(problemText(ADOPT_IMAGE_UNAVAILABLE));
  lines.push(problemText(ADOPT_STATE_UNREADABLE));
  lines.push(problemText(ADOPT_BUSY));
  lines.push(problemText(ADOPT_SETUP_FAILED));
  lines.push(problemText(OPEN_NOT_WINDOWS));
  lines.push(problemText(OPEN_NOT_INSTALLED));
  lines.push(problemText(OPEN_DOCKER_MISSING));
  lines.push(problemText(OPEN_DOCKER_DID_NOT_START));
  lines.push(problemText(OPEN_IMAGE_UNAVAILABLE));
  lines.push(problemText(OPEN_STATE_UNREADABLE));
  lines.push(problemText(OPEN_ADDRESS_MISSING));
  lines.push(problemText(OPEN_DID_NOT_ANSWER));
  lines.push(problemText(OPEN_CERT_MISSING));
  lines.push(problemText(OPEN_TRUST_FAILED));
  lines.push(openReadyLine('http://127.0.0.1:8791'));
  lines.push(problemText(openBrowserFailedProblem('http://127.0.0.1:8791')));
  lines.push(problemText(VERIFY_USAGE));
  lines.push(problemText(VERIFY_MANIFEST_MISSING));
  lines.push(problemText(VERIFY_SIGNATURE_MISSING));
  lines.push(problemText(VERIFY_MANIFEST_UNREADABLE));
  lines.push(problemText(VERIFY_SIGNATURE_BAD));
  lines.push(problemText(VERIFY_DOWNLOAD_UNREADABLE));
  lines.push(problemText(verifyNotListedProblem('aman-linux-x64')));
  lines.push(problemText(verifyChangedProblem('aman-linux-x64')));
  lines.push(problemText(VERIFY_SOURCE_IDS_MISMATCH));
  lines.push(verifyOkLine('aman-linux-x64'));
  lines.push(problemText(UPGRADE_NOT_WINDOWS));
  lines.push(problemText(UPGRADE_PROGRAM_MISSING));
  lines.push(problemText(UPGRADE_SOURCE_MISSING));
  lines.push(problemText(UPGRADE_DOWNLOAD_FAILED));
  lines.push(problemText(upgradeNotReadyProblem('Run aman doctor')));
  lines.push(problemText(UPGRADE_SMOKE_FAILED));
  lines.push(problemText(UPGRADE_REPLACE_FAILED));
  lines.push(problemText(UPGRADE_NEW_PROGRAM_WAITING));
  lines.push(problemText(UPGRADE_OLD_PROGRAM_NOT_BACK));
  lines.push(problemText(UPGRADE_SOURCE_FAILED));
  lines.push(problemText(UPGRADE_DOCKER_NOT_ANSWERING));
  lines.push(problemText(UPGRADE_BUSY));
  lines.push(problemText(UPGRADE_ROLLED_BACK));
  lines.push(problemText(UPGRADE_NOT_PUT_BACK));
  lines.push(problemText(UPGRADE_CONTAINER_FAILED));
  lines.push(upgradeQuestionLine('v0.0.0'));
  lines.push(UPGRADE_DECLINED_LINE);
  lines.push(UPGRADE_UP_TO_DATE_LINE);
  lines.push(UPGRADE_EXE_IN_PLACE_LINE);
  lines.push(upgradeDoneLine('v0.0.0'));
  lines.push(problemText(BACKUP_NOT_WINDOWS));
  lines.push(problemText(BACKUP_NOT_INSTALLED));
  lines.push(problemText(BACKUP_DOCKER_NOT_ANSWERING));
  lines.push(problemText(BACKUP_IMAGE_UNAVAILABLE));
  lines.push(problemText(BACKUP_STATE_UNREADABLE));
  lines.push(problemText(BACKUP_BUSY));
  lines.push(problemText(BACKUP_FAILED));
  lines.push(BACKUP_SAVED_LINE);
  lines.push(problemText(BACKUPS_NOT_WINDOWS));
  lines.push(problemText(BACKUPS_COULD_NOT_LIST));
  lines.push(NO_BACKUPS_LINE);
  lines.push(backupsFolderLine('C:\\Users\\Friend\\AppData\\Local\\Amanuensis\\backups'));
  lines.push(backupNameLine('20261009T120000Z'));
  lines.push(FILES_PRIVATE_LINE);
  lines.push(FILES_MADE_PRIVATE_LINE);
  lines.push(problemText(FILES_NOT_PRIVATE));
  lines.push(problemText(FILES_COULD_NOT_FIX));
  lines.push(problemText(FILES_COULD_NOT_CHECK));
  lines.push(problemText(NETWORK_USAGE));
  lines.push(problemText(NETWORK_NOT_WINDOWS));
  lines.push(problemText(NETWORK_NOT_INSTALLED));
  lines.push(problemText(NETWORK_IMAGE_UNAVAILABLE));
  lines.push(problemText(NETWORK_STATE_UNREADABLE));
  lines.push(problemText(NETWORK_ADDRESS_MISSING));
  lines.push(problemText(NETWORK_NO_ADDRESS));
  lines.push(problemText(NETWORK_DOCKER_NOT_ANSWERING));
  lines.push(problemText(NETWORK_BUSY));
  lines.push(problemText(NETWORK_OPEN_FAILED));
  lines.push(problemText(NETWORK_CLOSE_FAILED));
  lines.push(problemText(NETWORK_FIREWALL_OPEN_FAILED));
  lines.push(problemText(NETWORK_FIREWALL_CLOSE_FAILED));
  lines.push(NETWORK_OPEN_LINE);
  lines.push(NETWORK_CLOSED_LINE);
  lines.push(networkPhoneLine('http://192.168.1.20:8791'));
  lines.push(problemText(INSTALL_NOT_WINDOWS));
  lines.push(problemText(INSTALL_IMAGE_UNAVAILABLE));
  lines.push(problemText(INSTALL_DOWNLOAD_FAILED));
  lines.push(problemText(INSTALL_DOCKER_UNTRUSTED));
  lines.push(problemText(INSTALL_DOCKER_FAILED));
  lines.push(problemText(INSTALL_DOCKER_DID_NOT_START));
  lines.push(problemText(INSTALL_RESTART_NEEDED));
  lines.push(problemText(INSTALL_DOCKER_NOT_ANSWERING));
  lines.push(problemText(INSTALL_NO_ANSWER));
  lines.push(problemText(INSTALL_NO_FREE_PORT));
  lines.push(problemText(INSTALL_RELEASE_DOWNLOAD_FAILED));
  lines.push(problemText(INSTALL_SOURCE_MISSING));
  lines.push(problemText(INSTALL_SOURCE_FAILED));
  lines.push(problemText(INSTALL_BUSY));
  lines.push(problemText(INSTALL_CONTAINER_FAILED));
  lines.push(problemText(INSTALL_PAGE_FAILED));
  lines.push(problemText(INSTALL_KEY_ON_COMMAND_LINE));
  lines.push(problemText(installUsageProblem('--force')));
  lines.push(INSTALL_CONTINUING_LINE);
  lines.push(INSTALL_EMAIL_QUESTION);
  lines.push(INSTALL_PASSWORD_QUESTION);
  lines.push(INSTALL_PASSWORD_AGAIN_QUESTION);
  lines.push(INSTALL_PASSWORD_MISMATCH_LINE);
  lines.push(INSTALL_PASSWORD_TOO_LONG_LINE);
  lines.push(installPasswordProblem('short') ?? '');
  lines.push(installPasswordProblem('longenough') ?? '');
  lines.push(...INSTALL_KEY_HELP_LINES);
  lines.push(INSTALL_KEY_QUESTION);
  lines.push(INSTALL_KEY_EMPTY_LINE);
  lines.push(INSTALL_PHONE_QUESTION);
  lines.push(INSTALL_YES_OR_NO_LINE);
  lines.push(INSTALL_DONE_LINE);
  lines.push(...INSTALL_DRY_RUN_LINES);
  return lines;
}
