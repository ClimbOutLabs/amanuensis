// The state home as installer/STATE.md writes it down: the registry files,
// the release record and the backup list, read and written the way the
// shell writes them today, so an install made by either side reads the
// same to the other.

export class StateStoreError extends Error {}

export class StateBusyError extends StateStoreError {}

// The state volume could not be reached because Docker itself did not
// answer: it is not running, or its command never started.
export class StateDockerError extends StateStoreError {}

// A key or value the line formats cannot hold: a line break in a key or a
// value would render as extra lines the shell reader would take for real
// settings, and an equals sign in a key would move where a line splits.
export class StateValueError extends StateStoreError {}

export const REGISTRY_DIR = 'state/instances';
export const RELEASE_FILE = 'release/release.json';
export const PREVIOUS_RELEASE_FILE = 'release/previous.release.json';
export const BACKUPS_DIR = 'backups';
export const BACKUPS_MODE_FILE = 'state/backups';
export const SOURCE_FILE = 'state/source';
export const INSTALLED_FILE = 'state/installed';

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

function checkedRegistryKey(key: string): string {
  if (key.includes('=') || key.includes('\n') || key.includes('\r')) {
    throw new StateValueError('a registry key cannot hold an equals sign or a line break');
  }
  return key;
}

function checkedLineValue(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new StateValueError('a value to save cannot hold a line break');
  }
  return value;
}

// Replaces the key's line where it stands, or adds it at the end.
export function withRegistryValue(
  entries: readonly RegistryEntry[],
  key: string,
  value: string,
): readonly RegistryEntry[] {
  checkedRegistryKey(key);
  checkedLineValue(value);
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

export interface StateSummary {
  release: ReleaseRecord | null;
  releaseUnreadable: boolean;
  previousRelease: ReleaseRecord | null;
  instances: readonly InstanceRecord[];
  backups: readonly string[];
  backupsMode: string | null;
  sourceCheckout: string | null;
  installedAppImage: string | null;
}

// The low-level shape both backends provide: state files as text, folder
// listings as names, and writes of whole files that already differ.
export interface StateBackend {
  readText: (path: string) => Promise<string | null>;
  listNames: (dir: string) => Promise<readonly string[]>;
  writeChangedFiles: (files: readonly { path: string; text: string }[]) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
}

export interface StateStore {
  readSummary: () => Promise<StateSummary>;
  writeInstance: (record: InstanceRecord) => Promise<boolean>;
  setInstanceValue: (options: { name: string; key: string; value: string }) => Promise<boolean>;
  removeInstance: (name: string) => Promise<void>;
  writeRelease: (record: ReleaseRecord) => Promise<boolean>;
}

async function readSummaryFrom(backend: StateBackend): Promise<StateSummary> {
  const names = (await backend.listNames(REGISTRY_DIR))
    .filter(name => name.endsWith('.conf'))
    .map(name => name.slice(0, -'.conf'.length))
    .sort();
  const instances: InstanceRecord[] = [];
  for (const name of names) {
    const text = await backend.readText(`${REGISTRY_DIR}/${name}.conf`);
    if (text !== null) {
      instances.push({ name, entries: parseRegistry(text) });
    }
  }
  const releaseText = await backend.readText(RELEASE_FILE);
  const release = releaseText === null ? null : parseRelease(releaseText);
  const previousText = await backend.readText(PREVIOUS_RELEASE_FILE);
  const backups = [...(await backend.listNames(BACKUPS_DIR))].sort();
  const modeText = await backend.readText(BACKUPS_MODE_FILE);
  const sourceText = await backend.readText(SOURCE_FILE);
  const installedText = await backend.readText(INSTALLED_FILE);
  const installedParts = installedText === null ? [] : installedText.trim().split(/\s+/);
  return {
    release,
    releaseUnreadable: releaseText !== null && (release === null || !releaseIsReadable(release)),
    previousRelease: previousText === null ? null : parseRelease(previousText),
    instances,
    backups,
    backupsMode: modeText === null ? null : modeText.trim(),
    sourceCheckout: sourceText === null ? null : (sourceText.split('\n')[0] ?? '').trim() || null,
    installedAppImage: installedParts.length >= 2 ? (installedParts[1] ?? null) : null,
  };
}

function checkedInstanceName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new StateStoreError(`instance name is not one the registry can hold: ${name}`);
  }
  return name;
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
      for (const entry of record.entries) {
        if (entry.key !== null) {
          checkedRegistryKey(entry.key);
        }
        checkedLineValue(entry.value);
      }
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
          checkedLineValue(field);
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
