// The state home as installer/STATE.md writes it down: the registry files,
// the release record and the backup list, read and written the way the
// shell writes them today, so an install made by either side reads the
// same to the other.

export class StateStoreError extends Error {}

export class StateBusyError extends StateStoreError {}

// The state volume could not be reached because Docker itself did not
// answer: it is not running, or its command never started.
export class StateDockerError extends StateStoreError {}

// The helper image Docker needs for the state volume could not be got, for
// example because the computer is offline the first time it is needed.
export class StateImageError extends StateStoreError {}

export const REGISTRY_DIR = 'state/instances';
export const RELEASE_FILE = 'release/release.json';
export const PREVIOUS_RELEASE_FILE = 'release/previous.release.json';
export const BACKUPS_DIR = 'backups';
export const BACKUPS_MODE_FILE = 'state/backups';
export const SOURCE_FILE = 'state/source';
export const INSTALLED_FILE = 'state/installed';
export const CA_CERT_FILE = 'tls/ca/root.crt';
export const CA_KEY_FILE = 'tls/ca/root.key';
export const CA_FINGERPRINT_FILE = 'tls/ca/root.fingerprint';
const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]*$/;

// One line of a registry file. A line with no key is kept as it is, the way
// the shell's writer keeps lines it does not touch.
export interface RegistryEntry {
  key: string | null;
  value: string;
}

export interface InstanceRecord {
  name: string;
  entries: readonly RegistryEntry[];
}

export function parseRegistry(text: string): readonly RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }
    const splitAt = line.indexOf('=');
    if (splitAt === -1) {
      entries.push({ key: null, value: line });
    } else {
      entries.push({ key: line.slice(0, splitAt), value: line.slice(splitAt + 1) });
    }
  }
  return entries;
}

export function renderRegistry(entries: readonly RegistryEntry[]): string {
  const lines = entries.map(entry => (entry.key === null ? entry.value : `${entry.key}=${entry.value}`));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

// The first line that names the key wins, as with the shell's reader.
export function registryValue(entries: readonly RegistryEntry[], key: string): string | null {
  for (const entry of entries) {
    if (entry.key === key) {
      return entry.value;
    }
  }
  return null;
}

// A line that would read back as a different setting than the one written
// is refused: a line break adds lines the shell reader would take for real
// settings, an equals sign in a key moves where a line splits, and a line
// with no key but an equals sign would read back as a key.
function checkedEntry(entry: RegistryEntry): RegistryEntry {
  if (entry.value.includes('\n') || entry.value.includes('\r')) {
    throw new StateStoreError('a value to save cannot hold a line break');
  }
  if (entry.key === null) {
    if (entry.value.includes('=')) {
      throw new StateStoreError('a line with no name cannot hold an equals sign');
    }
    return entry;
  }
  if (entry.key === '' || entry.key.includes('=') || entry.key.includes('\n') || entry.key.includes('\r')) {
    throw new StateStoreError('a registry name cannot be empty or hold an equals sign or a line break');
  }
  return entry;
}

// Replaces the key's line where it stands, or adds it at the end.
export function withRegistryValue(
  entries: readonly RegistryEntry[],
  key: string,
  value: string,
): readonly RegistryEntry[] {
  checkedEntry({ key, value });
  const index = entries.findIndex(entry => entry.key === key);
  if (index === -1) {
    return [...entries, { key, value }];
  }
  return entries.map((entry, position) => (position === index ? { key, value } : entry));
}

export interface ReleaseRecord {
  schema: string | null;
  sourceRef: string | null;
  appImage: string | null;
  sttImage: string | null;
  calendarImage: string | null;
  dexImage: string | null;
  mailEmailImage: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

// Null when the text is not a release record at all.
export function parseRelease(text: string): ReleaseRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    schema: stringField(parsed, 'schema'),
    sourceRef: stringField(parsed, 'source_ref'),
    appImage: stringField(parsed, 'app_image'),
    sttImage: stringField(parsed, 'stt_image'),
    calendarImage: stringField(parsed, 'calendar_image'),
    dexImage: stringField(parsed, 'dex_image'),
    mailEmailImage: stringField(parsed, 'mail_email_image'),
  };
}

// The same shape release.sh writes: fixed key order, only the fields that
// are set, two-space indent.
export function renderRelease(record: ReleaseRecord): string {
  const fields: [string, string | null][] = [
    ['schema', record.schema],
    ['source_ref', record.sourceRef],
    ['app_image', record.appImage],
    ['stt_image', record.sttImage],
    ['calendar_image', record.calendarImage],
    ['dex_image', record.dexImage],
    ['mail_email_image', record.mailEmailImage],
  ];
  const lines = fields
    .filter((pair): pair is [string, string] => pair[1] !== null)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

// The shell loads a release record only when the app, speech and sign-in
// images are all named.
export function releaseIsReadable(record: ReleaseRecord): boolean {
  return record.appImage !== null && record.sttImage !== null && record.dexImage !== null;
}

// When a backup was made, as the backend can know it: a folder home reads
// the backup folder's own time, the volume reads the time in the backup's
// name (the installer names each backup by the time it was made). Null
// when the backend cannot say.
export interface BackupEntry {
  name: string;
  timeSeconds: number | null;
}

// The certificate authority's facts, as the backend can read them. The
// key's mode is the octal text the shell's file_mode prints, or null when
// there is no key file. On the volume the store does not read the tls
// folder in this stage, so every fact is absent there.
export interface CertificateAuthorityFacts {
  certPresent: boolean;
  keyMode: string | null;
  fingerprint: string | null;
  fingerprintHasContent: boolean;
}

export interface StateSummary {
  release: ReleaseRecord | null;
  releaseUnreadable: boolean;
  previousRelease: ReleaseRecord | null;
  instances: readonly InstanceRecord[];
  backups: readonly string[];
  backupEntries: readonly BackupEntry[];
  backupsMode: string | null;
  backupsModeTimeSeconds: number | null;
  certificateAuthority: CertificateAuthorityFacts;
  sourceCheckout: string | null;
  installedAppImage: string | null;
}

// The facts about one state path that a text read cannot give: when it
// last changed, its mode and size, and whether it is a folder.
export interface StatePathStat {
  mtimeSeconds: number;
  mode: number;
  size: number;
  isDirectory: boolean;
}

// The low-level shape both backends provide: state files as text, folder
// listings as names, and writes of whole files that already differ.
export interface StateBackend {
  readText: (path: string) => Promise<string | null>;
  listNames: (dir: string) => Promise<readonly string[]>;
  writeChangedFiles: (files: readonly { path: string; text: string }[]) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  // The stat facts the summary needs, or null when the path is not there
  // or the backend cannot say. A backend answers from what it already
  // holds where it can: the volume answers for a backup from the time in
  // its name, and for nothing else in this stage.
  statPath?: (path: string) => Promise<StatePathStat | null>;
}

export interface StateStore {
  readSummary: () => Promise<StateSummary>;
  writeInstance: (record: InstanceRecord) => Promise<boolean>;
  setInstanceValue: (options: { name: string; key: string; value: string }) => Promise<boolean>;
  removeInstance: (name: string) => Promise<void>;
  writeRelease: (record: ReleaseRecord) => Promise<boolean>;
}

async function readSummaryFrom(backend: StateBackend): Promise<StateSummary> {
  // A name found by listing the volume is untrusted until it fits the
  // instance name rule, since status prints it.
  const names = (await backend.listNames(REGISTRY_DIR))
    .filter(name => name.endsWith('.conf'))
    .map(name => name.slice(0, -'.conf'.length))
    .filter(name => INSTANCE_NAME.test(name))
    .sort();
  const instances: InstanceRecord[] = [];
  for (const name of names) {
    const text = await backend.readText(`${REGISTRY_DIR}/${name}.conf`);
    if (text !== null) {
      instances.push({ name, entries: parseRegistry(text) });
    }
  }
  // The doctor's probes answer null on any error, as the shell's [ -f ]
  // and stat probes do, so the facts below are read the same way: a path
  // that cannot be judged is a path that is not there.
  const statOrNull = async (path: string): Promise<StatePathStat | null> => {
    if (backend.statPath === undefined) {
      return null;
    }
    try {
      return await backend.statPath(path);
    } catch {
      return null;
    }
  };
  const readTextOrNull = async (path: string): Promise<string | null> => {
    try {
      return await backend.readText(path);
    } catch {
      return null;
    }
  };
  const releaseText = await backend.readText(RELEASE_FILE);
  const release = releaseText === null ? null : parseRelease(releaseText);
  const previousText = await backend.readText(PREVIOUS_RELEASE_FILE);
  const backups = [...(await backend.listNames(BACKUPS_DIR))].sort();
  const backupEntries: BackupEntry[] = [];
  for (const name of backups) {
    const stat = await statOrNull(`${BACKUPS_DIR}/${name}`);
    backupEntries.push({ name, timeSeconds: stat?.isDirectory === true ? stat.mtimeSeconds : null });
  }
  const modeText = await backend.readText(BACKUPS_MODE_FILE);
  const modeStat = await statOrNull(BACKUPS_MODE_FILE);
  const certStat = await statOrNull(CA_CERT_FILE);
  const keyStat = await statOrNull(CA_KEY_FILE);
  const fingerprintText = await readTextOrNull(CA_FINGERPRINT_FILE);
  const fingerprintStat = await statOrNull(CA_FINGERPRINT_FILE);
  const sourceText = await backend.readText(SOURCE_FILE);
  const installedText = await backend.readText(INSTALLED_FILE);
  const installedParts = installedText === null ? [] : installedText.trim().split(/\s+/);
  return {
    release,
    releaseUnreadable: releaseText !== null && (release === null || !releaseIsReadable(release)),
    previousRelease: previousText === null ? null : parseRelease(previousText),
    instances,
    backups,
    backupEntries,
    backupsMode: modeText === null ? null : modeText.trim(),
    backupsModeTimeSeconds: modeStat === null ? null : modeStat.mtimeSeconds,
    certificateAuthority: {
      certPresent: certStat !== null,
      keyMode: keyStat === null ? null : (keyStat.mode & 0o7777).toString(8),
      fingerprint: fingerprintText === null ? null : (fingerprintText.split('\n')[0] ?? ''),
      fingerprintHasContent: fingerprintStat !== null && fingerprintStat.size > 0,
    },
    sourceCheckout: sourceText === null ? null : (sourceText.split('\n')[0] ?? '').trim() || null,
    installedAppImage: installedParts.length >= 2 ? (installedParts[1] ?? null) : null,
  };
}

function checkedInstanceName(name: string): string {
  if (!INSTANCE_NAME.test(name)) {
    throw new StateStoreError(`instance name is not one the registry can hold: ${name}`);
  }
  return name;
}

// The shell reads the release record line by line, so a field with a quote,
// a backslash or a control character in it would be read back wrong. JSON
// escapes those correctly, but the shell's reader does not undo the escapes.
const RELEASE_FIELD = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

function checkedReleaseField(field: string): string {
  if (!RELEASE_FIELD.test(field)) {
    throw new StateStoreError('a release record field can hold only an image name or an id');
  }
  return field;
}

// The writers compare before they write, like the shell's write_if_changed,
// and report whether anything changed.
export function createStateStore(backend: StateBackend): StateStore {
  const writeOneIfChanged = async (path: string, text: string): Promise<boolean> => {
    const current = await backend.readText(path);
    if (current === text) {
      return false;
    }
    await backend.writeChangedFiles([{ path, text }]);
    return true;
  };
  return {
    readSummary: () => readSummaryFrom(backend),
    writeInstance: async record => {
      record.entries.forEach(checkedEntry);
      return writeOneIfChanged(
        `${REGISTRY_DIR}/${checkedInstanceName(record.name)}.conf`,
        renderRegistry(record.entries),
      );
    },
    setInstanceValue: async options => {
      const path = `${REGISTRY_DIR}/${checkedInstanceName(options.name)}.conf`;
      const current = await backend.readText(path);
      const entries = withRegistryValue(current === null ? [] : parseRegistry(current), options.key, options.value);
      return writeOneIfChanged(path, renderRegistry(entries));
    },
    removeInstance: async name => {
      await backend.removeFile(`${REGISTRY_DIR}/${checkedInstanceName(name)}.conf`);
    },
    writeRelease: async record => {
      for (const field of [
        record.schema,
        record.sourceRef,
        record.appImage,
        record.sttImage,
        record.calendarImage,
        record.dexImage,
        record.mailEmailImage,
      ]) {
        if (field !== null) {
          checkedReleaseField(field);
        }
      }
      const text = renderRelease(record);
      const current = await backend.readText(RELEASE_FILE);
      if (current === text) {
        return false;
      }
      const changed: { path: string; text: string }[] = [];
      if (current !== null) {
        changed.push({ path: PREVIOUS_RELEASE_FILE, text: current });
      }
      changed.push({ path: RELEASE_FILE, text });
      await backend.writeChangedFiles(changed);
      return true;
    },
  };
}
