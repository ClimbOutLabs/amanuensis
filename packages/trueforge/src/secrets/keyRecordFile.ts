import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { errorCode } from '../cli/errorCode';
import type {
  CompareAndSetGlobalSettingInput,
  GetGlobalSettingInput,
  GlobalSettingRecord,
  IGlobalSettingsStore,
  SetGlobalSettingInput,
} from '../db/globalSettingsStore';

const KeyRecordsSchema = z.record(z.string(), z.object({ value: z.string(), updated_at: z.string() }));

type KeyRecords = z.infer<typeof KeyRecordsSchema>;

/** The file beside a SQLite database that holds its key records. */
export function keyRecordPath(sqlitePath: string): string {
  return `${sqlitePath}.keys`;
}

/**
 * The key records of a SQLite instance: its key check value, its recovery copy and its earlier
 * keys. They live in a file beside the database, not in it, because they are what opens the
 * encrypted database. Nothing in the file is usable without the machine key or the recovery key.
 */
export class KeyRecordFile implements IGlobalSettingsStore {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async getSetting({ key }: GetGlobalSettingInput): Promise<GlobalSettingRecord | undefined> {
    const record = (await this.#read())[key];
    return record === undefined ? undefined : { key, ...record };
  }

  async setSetting({ key, value }: SetGlobalSettingInput): Promise<GlobalSettingRecord> {
    const records = await this.#read();
    const record = { value, updated_at: new Date().toISOString() };
    await this.#write({ ...records, [key]: record });
    return { key, ...record };
  }

  async deleteSetting({ key }: GetGlobalSettingInput): Promise<void> {
    const records = await this.#read();
    if (records[key] !== undefined) {
      await this.#write(Object.fromEntries(Object.entries(records).filter(([name]) => name !== key)));
    }
  }

  // Setup is the only writer and runs alone, so read-then-write is enough here.
  async compareAndSetSetting({ key, expected, value }: CompareAndSetGlobalSettingInput): Promise<boolean> {
    const current = (await this.#read())[key]?.value ?? null;
    if (current !== expected) {
      return false;
    }
    if (value === null) {
      await this.deleteSetting({ key });
    } else {
      await this.setSetting({ key, value });
    }
    return true;
  }

  async #read(): Promise<KeyRecords> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (caught) {
      if (errorCode(caught) === 'ENOENT') {
        return {};
      }
      throw caught;
    }
    return KeyRecordsSchema.parse(JSON.parse(text));
  }

  /** Written whole to a new file that then takes the name, so a crash never leaves half a file. */
  async #write(records: KeyRecords): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const part = `${this.#file}.${randomBytes(6).toString('hex')}.part`;
    try {
      await writeFile(part, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(part, this.#file);
    } catch (caught) {
      await rm(part, { force: true });
      throw caught;
    }
  }
}
