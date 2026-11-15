import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './atomicFile.js';

/** Which store holds a paired instance's terminal key. The key itself is never written here. */
export type KeyStoreKind = 'keychain' | 'file';

/** One Aman instance this terminal is paired with. Holds no secret. */
export interface SavedInstance {
  /** The instance address the person gave at pairing, used as the base for every call. */
  address: string;
  /** The name the terminal paired under, as the person saw it in the web app. */
  deviceName: string;
  /** Where this instance's terminal key lives. */
  keyStore: KeyStoreKind;
}

/** The saved instances and which one the app opens by default. */
export interface InstanceStore {
  instances: SavedInstance[];
  activeAddress: string | null;
}

const STORE_FILE = 'instances.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readInstance(value: unknown): SavedInstance | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const address = readNonEmptyString(value.address);
  const deviceName = readNonEmptyString(value.deviceName);
  const keyStore = value.keyStore;
  if (address === undefined || deviceName === undefined) {
    return undefined;
  }
  if (keyStore !== 'keychain' && keyStore !== 'file') {
    return undefined;
  }
  return { address, deviceName, keyStore };
}

/** The address as the person typed it, tidied into the base every call builds on. */
export function normalizeInstanceAddress(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') {
    return undefined;
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.hostname === '') {
    return undefined;
  }
  return withScheme.replace(/\/+$/, '');
}

/** Reads the saved instances. A missing or unreadable file reads as no instances. */
export function loadInstanceStore(configDir: string): InstanceStore {
  let raw: string;
  try {
    raw = readFileSync(path.join(configDir, STORE_FILE), 'utf8');
  } catch {
    return { instances: [], activeAddress: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { instances: [], activeAddress: null };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.instances)) {
    return { instances: [], activeAddress: null };
  }
  const instances: SavedInstance[] = [];
  for (const row of parsed.instances) {
    const instance = readInstance(row);
    if (instance !== undefined) {
      instances.push(instance);
    }
  }
  const active = readNonEmptyString(parsed.activeAddress);
  return {
    instances,
    activeAddress: active !== undefined && instances.some(instance => instance.address === active) ? active : null,
  };
}

/** Writes the saved instances owner-only: the folder at 0700 and the file at 0600. */
export function saveInstanceStore(configDir: string, store: InstanceStore): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  writeFileAtomic({
    filePath: path.join(configDir, STORE_FILE),
    content: `${JSON.stringify(store, null, 2)}\n`,
    mode: 0o600,
  });
}

/** Adds a pairing, or refreshes the row a re-pairing of the same address replaces, and makes it active. */
export function upsertInstance(store: InstanceStore, instance: SavedInstance): InstanceStore {
  const instances = store.instances.filter(saved => saved.address !== instance.address);
  instances.push(instance);
  return { instances, activeAddress: instance.address };
}

/** The instance the app opens by default: the active one, else the only one, else none. */
export function activeInstance(store: InstanceStore): SavedInstance | undefined {
  if (store.activeAddress !== null) {
    return store.instances.find(instance => instance.address === store.activeAddress);
  }
  return store.instances.length === 1 ? store.instances[0] : undefined;
}
