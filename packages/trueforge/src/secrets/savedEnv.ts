import { z } from 'zod';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { decryptSecret, encryptSecret, masterKeyId, secretKeyId, type SecretContext } from './secretCipher';

/** Settings key that holds the paid-account keys of this instance, each one encrypted. */
export const SAVED_ENV_SETTING = 'secrets_saved_env';

/**
 * The settings that are keys to a paid account. They are kept encrypted beside the database and
 * given to Aman when it starts, so they never have to sit in the readable settings file.
 */
export const SAVED_ENV_NAMES = ['NEBIUS_API_KEY', 'TAVILY_API_KEY', 'TWILIO_AUTH_TOKEN'] as const;

export const SavedEnvNameSchema = z.enum(SAVED_ENV_NAMES);
export type SavedEnvName = z.infer<typeof SavedEnvNameSchema>;

const SavedEnvSchema = z.record(z.string(), z.string());
type SavedEnv = z.infer<typeof SavedEnvSchema>;

function context(name: string): SecretContext {
  return { table: 'saved_env', primary_key: name, field: 'value' };
}

/** The stored map, from the text of its setting. Nothing in it is readable without the key. */
export function parseSavedEnv(value: string | undefined): SavedEnv {
  return value === undefined ? {} : SavedEnvSchema.parse(JSON.parse(value));
}

/** Every saved value in plain text, for the process that is about to use them. */
export function openSavedEnv({ saved, key }: { saved: SavedEnv; key: Buffer }): Record<string, string> {
  return Object.fromEntries(
    Object.entries(saved).map(([name, value]) => [name, decryptSecret({ key, value, context: context(name) })]),
  );
}

async function read(settings: IGlobalSettingsStore): Promise<SavedEnv> {
  return parseSavedEnv((await settings.getSetting({ key: SAVED_ENV_SETTING }))?.value);
}

async function write({ settings, saved }: { settings: IGlobalSettingsStore; saved: SavedEnv }): Promise<void> {
  if (Object.keys(saved).length === 0) {
    await settings.deleteSetting({ key: SAVED_ENV_SETTING });
  } else {
    await settings.setSetting({ key: SAVED_ENV_SETTING, value: JSON.stringify(saved) });
  }
}

export async function savedEnvNames({ settings }: { settings: IGlobalSettingsStore }): Promise<string[]> {
  return Object.keys(await read(settings)).sort();
}

export async function putSavedEnv({
  settings,
  key,
  name,
  value,
}: {
  settings: IGlobalSettingsStore;
  key: Buffer;
  name: SavedEnvName;
  value: string;
}): Promise<void> {
  const saved = await read(settings);
  await write({
    settings,
    saved: { ...saved, [name]: encryptSecret({ key, plaintext: value, context: context(name) }) },
  });
}

export async function dropSavedEnv({
  settings,
  name,
}: {
  settings: IGlobalSettingsStore;
  name: SavedEnvName;
}): Promise<void> {
  const saved = await read(settings);
  await write({ settings, saved: Object.fromEntries(Object.entries(saved).filter(([held]) => held !== name)) });
}

/**
 * Puts every saved value under `to` when the database moves to another computer. A value already
 * under `to` is left alone, so a move that stopped halfway can be run again.
 */
export async function moveSavedEnv({
  settings,
  from,
  to,
}: {
  settings: IGlobalSettingsStore;
  from: Buffer;
  to: Buffer;
}): Promise<void> {
  const saved = await read(settings);
  const current = masterKeyId(to).toString('hex');
  const moved = Object.fromEntries(
    Object.entries(saved).map(([name, value]) => [
      name,
      secretKeyId(value) === current
        ? value
        : encryptSecret({
            key: to,
            plaintext: decryptSecret({ key: from, value, context: context(name) }),
            context: context(name),
          }),
    ]),
  );
  if (Object.keys(moved).length > 0) {
    await write({ settings, saved: moved });
  }
}
