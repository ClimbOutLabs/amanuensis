import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  activeInstance,
  loadInstanceStore,
  normalizeInstanceAddress,
  saveInstanceStore,
  upsertInstance,
  type SavedInstance,
} from '../src/instances.js';
import { lastActiveWord, outcomeOfDisposition, outcomeWord, plainToolName, toolCallDetail } from '../src/words.js';

const NORA: SavedInstance = { address: 'https://nora.example:8443', deviceName: 'Pippa', keyStore: 'file' };
const SECOND: SavedInstance = {
  address: 'https://second.example:8443',
  deviceName: 'Desk terminal',
  keyStore: 'keychain',
};

describe('normalizeInstanceAddress', () => {
  it('adds https when the scheme is missing and trims trailing slashes', () => {
    expect(normalizeInstanceAddress('nora.example:8443')).toBe('https://nora.example:8443');
    expect(normalizeInstanceAddress(' http://nora.example:8443/ ')).toBe('http://nora.example:8443');
  });

  it('reads a non-address as no address', () => {
    expect(normalizeInstanceAddress('')).toBeUndefined();
    expect(normalizeInstanceAddress('http://')).toBeUndefined();
  });
});

describe('the instance store', () => {
  it('saves owner-only and loads back, with the switch surviving', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'aman-tui-instances-'));
    let store = upsertInstance({ instances: [], activeAddress: null }, NORA);
    store = upsertInstance(store, SECOND);
    expect(activeInstance(store)).toEqual(SECOND);
    store = { instances: store.instances, activeAddress: NORA.address };
    saveInstanceStore(configDir, store);
    expect(statSync(path.join(configDir, 'instances.json')).mode & 0o777).toBe(0o600);
    const loaded = loadInstanceStore(configDir);
    expect(loaded).toEqual(store);
    expect(activeInstance(loaded)).toEqual(NORA);
  });

  it('re-pairing an address replaces its row and makes it active', () => {
    let store = upsertInstance({ instances: [], activeAddress: null }, NORA);
    store = upsertInstance(store, SECOND);
    store = upsertInstance(store, { ...NORA, deviceName: 'Pippa two' });
    expect(store.instances).toHaveLength(2);
    expect(activeInstance(store)?.deviceName).toBe('Pippa two');
  });

  it('falls back to the only instance, and to none when several are saved with no active one', () => {
    expect(activeInstance({ instances: [NORA], activeAddress: null })).toEqual(NORA);
    expect(activeInstance({ instances: [NORA, SECOND], activeAddress: null })).toBeUndefined();
    expect(activeInstance({ instances: [], activeAddress: null })).toBeUndefined();
  });

  it('reads a damaged file as no instances', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'aman-tui-instances-'));
    writeFileSync(path.join(configDir, 'instances.json'), 'not json');
    expect(loadInstanceStore(configDir)).toEqual({ instances: [], activeAddress: null });
  });
});

describe('plain words', () => {
  it('names a tool in plain words, with any server prefix stripped', () => {
    expect(plainToolName('mcp__gmail__send_email')).toBe('Send email');
    expect(plainToolName('read_file')).toBe('Read file');
    expect(plainToolName('')).toBe('A tool');
  });

  it('takes the detail from the argument a person would recognise', () => {
    expect(toolCallDetail('{"query":"invoices from Nora"}')).toBe('invoices from Nora');
    expect(toolCallDetail('{"path":"/notes/today.md"}')).toBe('/notes/today.md');
    expect(toolCallDetail('not json')).toBeNull();
    expect(toolCallDetail('{"count":3}')).toBeNull();
    expect(toolCallDetail(undefined)).toBeNull();
  });

  it('words outcomes plainly', () => {
    expect(outcomeOfDisposition('executed_ok')).toBe('done');
    expect(outcomeOfDisposition('executed_nonzero')).toBe('failed');
    expect(outcomeOfDisposition('outcome_unknown')).toBe('unclear');
    expect(outcomeOfDisposition('denied')).toBe('not_run');
    expect(outcomeWord('done')).toBe('Done');
    expect(outcomeWord('waiting_approval')).toBe('Waiting for approval');
  });

  it('words last activity the way a person scans a list', () => {
    const now = new Date('2026-11-15T12:00:00');
    expect(lastActiveWord('2026-11-15T11:59:30', now)).toBe('just now');
    expect(lastActiveWord('2026-11-15T11:45:00', now)).toBe('15 min ago');
    expect(lastActiveWord('2026-11-15T09:00:00', now)).toBe('3 hr ago');
    expect(lastActiveWord('2026-11-14T18:00:00', now)).toBe('Yesterday');
    expect(lastActiveWord('2026-11-03T18:00:00', now)).toBe('Nov 3');
    expect(lastActiveWord('not a date', now)).toBe('');
  });
});
