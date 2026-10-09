import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingModel,
  type EmbeddingModelPhase,
} from '../../../../src/runtime/memory/embeddingModel';
import { EmbeddingSubsystem } from '../../../../src/runtime/memory/embeddingRetrieval';
import { EmbeddingStore, hashEntryText } from '../../../../src/runtime/memory/embeddingStore';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { writeVaultSharing, type VaultScope } from '../../../../src/runtime/memory/markdownMemoryFiles';

const TENANT = 'tenant-1';
const TIMEOUT_MS = 5000;
const ALPHA: VaultScope = { personaName: 'Alpha', personaId: 'persona-alpha-id' };
const BETA: VaultScope = { personaName: 'Beta', personaId: 'persona-beta-id' };
const GAMMA: VaultScope = { personaName: 'Gamma', personaId: 'persona-gamma-id' };

let baseDir = '';
let operationCounter = 0;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'persona-vault-'));
  operationCounter = 0;
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function clientFor(scope: VaultScope | undefined): MarkdownMemoryClient {
  return new MarkdownMemoryClient({ baseDir, namespace: TENANT, vaultScope: scope });
}

async function retainMany(client: MarkdownMemoryClient, contents: string[], operationId?: string): Promise<void> {
  operationCounter += 1;
  const outcome = await client.retain({
    items: contents.map((content, index) => ({
      content,
      timestamp: `2026-09-26T10:0${String(index)}:00.000Z`,
      document_id: `doc-${String(operationCounter)}-${String(index)}`,
    })),
    operationId: operationId ?? `op-${String(operationCounter)}`,
    timeoutMs: TIMEOUT_MS,
  });
  expect(outcome).toEqual({ ok: true });
}

async function retain(client: MarkdownMemoryClient, content: string, operationId?: string): Promise<void> {
  await retainMany(client, [content], operationId);
}

async function recall(client: MarkdownMemoryClient, query: string, maxTokens = 4000): Promise<string[]> {
  const outcome = await client.recall({
    query,
    maxTokens,
    queryTimestamp: '2026-09-27T10:00:00.000Z',
    entityTokens: 0,
    timeoutMs: TIMEOUT_MS,
  });
  if (!outcome.ok) {
    throw new Error(`recall failed: ${outcome.reason}`);
  }
  return outcome.results.map(item => item.text);
}

function mentions(texts: string[], needle: string): boolean {
  return texts.some(text => text.includes(needle));
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function listedIds(client: MarkdownMemoryClient, namespace: string): Promise<string[]> {
  const outcome = await client.listEntries({ namespace, timeoutMs: TIMEOUT_MS });
  if (!outcome.ok) {
    throw new Error(`list failed: ${outcome.reason}`);
  }
  return outcome.entries.map(entry => entry.id);
}

describe('MarkdownMemoryClient persona vault scope', () => {
  describe('isolation', () => {
    it('does not recall a fact retained by another persona', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');

      expect(mentions(await recall(clientFor(BETA), 'quince jam'), 'quince')).toBe(false);
      expect(mentions(await recall(clientFor(ALPHA), 'quince jam'), 'quince')).toBe(true);
    });

    it('keeps persona facts out of the default assistant recall', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');

      expect(await recall(clientFor(undefined), 'quince jam')).toEqual([]);
    });

    it('writes a persona fact only into that persona vault directory', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');

      const personaLog = await readFile(
        path.join(baseDir, 'tenant-1__persona_Alpha', 'memory', '2026-09-26.md'),
        'utf8',
      );
      expect(personaLog).toContain('quince jam');
      expect(await exists(path.join(baseDir, TENANT, 'memory'))).toBe(false);
      expect(await exists(path.join(baseDir, 'tenant-1__persona_Beta'))).toBe(false);
    });
  });

  describe('shared vault', () => {
    it('writes no-persona facts to the shared vault', async () => {
      await retain(clientFor(undefined), 'The household recycles on Thursdays');

      const sharedLog = await readFile(path.join(baseDir, TENANT, 'memory', '2026-09-26.md'), 'utf8');
      expect(sharedLog).toContain('recycles on Thursdays');
      const dirs = await readdir(baseDir);
      expect(dirs.filter(name => name.includes('__persona_'))).toEqual([]);
    });

    it('is readable by every persona and by the default assistant', async () => {
      await retain(clientFor(undefined), 'The household recycles on Thursdays');

      for (const scope of [ALPHA, BETA, undefined]) {
        expect(mentions(await recall(clientFor(scope), 'recycles Thursdays'), 'recycles on Thursdays')).toBe(true);
      }
    });

    it('is not written to by a persona retain', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');

      expect(await recall(clientFor(BETA), 'quince jam')).toEqual([]);
      expect(await listedIds(clientFor(undefined), '')).toEqual([]);
    });
  });

  describe('sharing grants', () => {
    it('lets a persona recall a vault shared with it, keyed by persona name', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');
      await writeVaultSharing({
        baseDir,
        tenantNamespace: TENANT,
        sharing: { version: 1, shares: { Beta: ['persona:Alpha'] } },
      });

      expect(mentions(await recall(clientFor(BETA), 'quince jam'), 'quince')).toBe(true);
      // The grant is for Beta only.
      expect(mentions(await recall(clientFor(GAMMA), 'quince jam'), 'quince')).toBe(false);
    });

    it('also honors a grant keyed by persona id', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');
      await writeVaultSharing({
        baseDir,
        tenantNamespace: TENANT,
        sharing: { version: 1, shares: { [BETA.personaId]: ['persona:Alpha'] } },
      });

      expect(mentions(await recall(clientFor(BETA), 'quince jam'), 'quince')).toBe(true);
    });

    it('is read-only: the grantee still writes to its own vault', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');
      await writeVaultSharing({
        baseDir,
        tenantNamespace: TENANT,
        sharing: { version: 1, shares: { Beta: ['persona:Alpha'] } },
      });

      await retain(clientFor(BETA), 'Beta prefers oolong tea');

      expect(mentions(await recall(clientFor(ALPHA), 'oolong tea'), 'oolong')).toBe(false);
      expect(await listedIds(clientFor(undefined), 'persona:Alpha')).toHaveLength(1);
      expect(await listedIds(clientFor(undefined), 'persona:Beta')).toHaveLength(1);
    });

    it('stops recalling a vault once the grant is removed', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');
      await writeVaultSharing({
        baseDir,
        tenantNamespace: TENANT,
        sharing: { version: 1, shares: { Beta: ['persona:Alpha'] } },
      });
      expect(mentions(await recall(clientFor(BETA), 'quince jam'), 'quince')).toBe(true);

      await writeVaultSharing({ baseDir, tenantNamespace: TENANT, sharing: { version: 1, shares: {} } });

      expect(mentions(await recall(clientFor(BETA), 'quince jam'), 'quince')).toBe(false);
    });

    it('recalls a shared topic vault', async () => {
      const topicWriter = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1__finance' });
      await retain(topicWriter, 'The budget review is every second Monday');
      await writeVaultSharing({
        baseDir,
        tenantNamespace: TENANT,
        sharing: { version: 1, shares: { Beta: ['finance'] } },
      });

      expect(mentions(await recall(clientFor(BETA), 'budget review'), 'budget review')).toBe(true);
      expect(mentions(await recall(clientFor(ALPHA), 'budget review'), 'budget review')).toBe(false);
    });
  });

  describe('delete and edit', () => {
    it('stops recalling a deleted persona fact', async () => {
      const alpha = clientFor(ALPHA);
      await retain(alpha, 'Alpha keeps quince jam in the pantry');
      const [entryId] = await listedIds(alpha, 'persona:Alpha');
      if (entryId === undefined) {
        throw new Error('expected one persona vault entry');
      }

      expect(await alpha.deleteEntry({ entryId, timeoutMs: TIMEOUT_MS })).toEqual({ ok: true });

      expect(await recall(clientFor(ALPHA), 'quince jam')).toEqual([]);
    });

    it('stops recalling a deleted fact for a persona it was shared with', async () => {
      const alpha = clientFor(ALPHA);
      await retain(alpha, 'Alpha keeps quince jam in the pantry');
      await writeVaultSharing({
        baseDir,
        tenantNamespace: TENANT,
        sharing: { version: 1, shares: { Beta: ['persona:Alpha'] } },
      });
      expect(mentions(await recall(clientFor(BETA), 'quince jam'), 'quince')).toBe(true);
      const [entryId] = await listedIds(alpha, 'persona:Alpha');
      if (entryId === undefined) {
        throw new Error('expected one persona vault entry');
      }

      await alpha.deleteEntry({ entryId, timeoutMs: TIMEOUT_MS });

      expect(await recall(clientFor(BETA), 'quince jam')).toEqual([]);
    });

    it('stops recalling a deleted shared-vault fact for every persona', async () => {
      const shared = clientFor(undefined);
      await retain(shared, 'The household recycles on Thursdays');
      const [entryId] = await listedIds(shared, '');
      if (entryId === undefined) {
        throw new Error('expected one shared vault entry');
      }

      await shared.deleteEntry({ entryId, timeoutMs: TIMEOUT_MS });

      for (const scope of [ALPHA, BETA, undefined]) {
        expect(await recall(clientFor(scope), 'recycles Thursdays')).toEqual([]);
      }
    });

    it('recalls the edited text of a persona fact', async () => {
      const alpha = clientFor(ALPHA);
      await retain(alpha, 'Alpha keeps quince jam in the pantry');
      const [entryId] = await listedIds(alpha, 'persona:Alpha');
      if (entryId === undefined) {
        throw new Error('expected one persona vault entry');
      }

      await alpha.updateEntry({ entryId, text: 'Alpha keeps damson jam in the cellar', timeoutMs: TIMEOUT_MS });

      const recalled = await recall(clientFor(ALPHA), 'jam');
      expect(mentions(recalled, 'damson')).toBe(true);
      expect(mentions(recalled, 'quince')).toBe(false);
    });
  });

  describe('recall composition', () => {
    it('gives the shared vault a place in a tight budget instead of filling it from the persona vault', async () => {
      const alpha = clientFor(ALPHA);
      for (const fruit of ['quince', 'damson', 'medlar']) {
        await retain(alpha, `Alpha stores ${fruit} preserves for winter`);
      }
      await retain(clientFor(undefined), 'The cellar stores preserves for winter too');

      // Room for two entries: one from each vault, not two from the persona vault.
      const recalled = await recall(clientFor(ALPHA), 'preserves winter', 40);

      expect(recalled).toHaveLength(2);
      expect(mentions(recalled, 'cellar')).toBe(true);
      expect(mentions(recalled, 'Alpha stores')).toBe(true);
    });

    it('includes a vault MEMORY.md for each readable vault only', async () => {
      await mkdir(path.join(baseDir, 'tenant-1__persona_Alpha'), { recursive: true });
      await writeFile(path.join(baseDir, 'tenant-1__persona_Alpha', 'MEMORY.md'), 'Alpha curated notes', 'utf8');
      await mkdir(path.join(baseDir, 'tenant-1__persona_Beta'), { recursive: true });
      await writeFile(path.join(baseDir, 'tenant-1__persona_Beta', 'MEMORY.md'), 'Beta curated notes', 'utf8');

      const recalled = await recall(clientFor(ALPHA), 'anything');

      expect(recalled).toEqual(['Alpha curated notes']);
    });
  });

  describe('rename and delete', () => {
    it('leaves the old vault intact and gives a renamed persona an empty vault', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');
      const renamed: VaultScope = { personaName: 'Alpha Prime', personaId: ALPHA.personaId };

      expect(await recall(clientFor(renamed), 'quince jam')).toEqual([]);
      // The old vault stays listable, and recreating the old name reconnects to it.
      expect(await listedIds(clientFor(undefined), 'persona:Alpha')).toHaveLength(1);
      expect(mentions(await recall(clientFor(ALPHA), 'quince jam'), 'quince')).toBe(true);
    });

    it('keeps a deleted persona vault untouched and unreadable by others', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry');

      // No persona maps to the vault any more: nobody recalls it, nothing is removed.
      expect(await recall(clientFor(BETA), 'quince jam')).toEqual([]);
      expect(await recall(clientFor(undefined), 'quince jam')).toEqual([]);
      expect(await listedIds(clientFor(undefined), 'persona:Alpha')).toHaveLength(1);
    });
  });

  describe('per-vault state', () => {
    it('tracks retain operation ids per vault', async () => {
      const alpha = clientFor(ALPHA);
      const beta = clientFor(BETA);
      const shared = clientFor(undefined);

      await retain(alpha, 'Alpha keeps quince jam in the pantry', 'op-same');
      // The same operation id in another vault is a different retain, not a duplicate.
      await retain(beta, 'Beta prefers oolong tea', 'op-same');
      await retain(shared, 'The household recycles on Thursdays', 'op-same');

      expect(mentions(await recall(clientFor(BETA), 'oolong tea'), 'oolong')).toBe(true);
      expect(mentions(await recall(clientFor(undefined), 'recycles Thursdays'), 'recycles')).toBe(true);
      expect(await alpha.getOperation('op-same', TIMEOUT_MS)).toMatchObject({ ok: true, status: 'completed' });
      expect(await clientFor(GAMMA).getOperation('op-same', TIMEOUT_MS)).toMatchObject({
        ok: true,
        status: 'unknown',
      });
      for (const directory of ['tenant-1__persona_Alpha', 'tenant-1__persona_Beta', TENANT]) {
        const ids: unknown = JSON.parse(await readFile(path.join(baseDir, directory, '.operations.json'), 'utf8'));
        expect(ids).toEqual(['op-same']);
      }
    });

    it('does not mark an operation completed in a vault that never saw it', async () => {
      await retain(clientFor(ALPHA), 'Alpha keeps quince jam in the pantry', 'op-alpha-only');

      expect(await clientFor(BETA).getOperation('op-alpha-only', TIMEOUT_MS)).toMatchObject({
        ok: true,
        status: 'unknown',
      });
      expect(await clientFor(undefined).getOperation('op-alpha-only', TIMEOUT_MS)).toMatchObject({
        ok: true,
        status: 'unknown',
      });
      expect(await exists(path.join(baseDir, TENANT, '.operations.json'))).toBe(false);
    });
  });
});

function oneHot(index: number): number[] {
  const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  values[index % EMBEDDING_DIMENSIONS] = 1;
  return values;
}

/** Lodging text embeds on axis 0, everything else on axis 1, so meaning matches without shared keywords. */
function lodgingVector(text: string): number[] {
  return oneHot(/hotel|lodging|accommodation|tent/i.test(text) ? 0 : 1);
}

class LodgingEmbeddingModel extends EmbeddingModel {
  constructor() {
    super({ modelDir: path.join(tmpdir(), 'fake-embedding-model') });
  }

  override get currentPhase(): EmbeddingModelPhase {
    return 'ready';
  }

  override async ensureReady(): Promise<boolean> {
    return true;
  }

  override async embedQueries(texts: string[]): Promise<number[][]> {
    return texts.map(lodgingVector);
  }

  override async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map(lodgingVector);
  }
}

async function waitFor(condition: () => Promise<boolean> | boolean, description: string): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > 15000) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function waitForIndexed(subsystem: EmbeddingSubsystem, entries: number): Promise<void> {
  await waitFor(
    () => subsystem.getStatus().state === 'ready' && subsystem.getStatus().indexedEntries >= entries,
    `${String(entries)} indexed entries: ${subsystem.getStatus().detail}`,
  );
}

async function storedIds(namespace: string): Promise<string[]> {
  return (await EmbeddingStore.load({ namespaceDir: path.join(baseDir, namespace) })).ids();
}

describe('MarkdownMemoryClient persona vault scope with embeddings', () => {
  function embeddedClients() {
    const model = new LodgingEmbeddingModel();
    const subsystems = new Map<string, EmbeddingSubsystem>();
    const requested = new Set<string>();
    const embeddings = (namespace: string): EmbeddingSubsystem => {
      requested.add(namespace);
      const existing = subsystems.get(namespace);
      if (existing !== undefined) {
        return existing;
      }
      const created = new EmbeddingSubsystem({
        baseDir,
        namespace,
        modelDir: path.join(baseDir, 'model'),
        batchSize: 2,
        model,
      });
      subsystems.set(namespace, created);
      return created;
    };
    const clientWith = (scope: VaultScope | undefined) =>
      new MarkdownMemoryClient({ baseDir, namespace: TENANT, vaultScope: scope, embeddings });
    return { clientWith, subsystems, requested };
  }

  function subsystemOf(subsystems: Map<string, EmbeddingSubsystem>, namespace: string): EmbeddingSubsystem {
    const subsystem = subsystems.get(namespace);
    if (subsystem === undefined) {
      throw new Error(`expected an embedding subsystem for ${namespace}`);
    }
    return subsystem;
  }

  it('indexes each vault in its own store and never in another vault', async () => {
    const { clientWith, subsystems } = embeddedClients();
    await retainMany(clientWith(ALPHA), ['Alpha lodging is a hotel in Lisbon', 'Alpha owns a bicycle']);
    await retainMany(clientWith(BETA), ['Beta lodging is a hotel in Porto', 'Beta owns a canoe']);
    await retainMany(clientWith(undefined), ['The family hotel is in Madrid', 'The family owns a kayak']);

    for (const namespace of ['tenant-1__persona_Alpha', 'tenant-1__persona_Beta', TENANT]) {
      await waitForIndexed(subsystemOf(subsystems, namespace), 2);
      const ids = await storedIds(namespace);
      expect(ids).toHaveLength(2);
      expect(ids.every(id => id.startsWith(`md:${namespace}:`))).toBe(true);
    }
  });

  it('does not recall another persona by meaning', async () => {
    const { clientWith, subsystems, requested } = embeddedClients();
    await retainMany(clientWith(BETA), ['Beta lodging is a hotel in Porto', 'Beta owns a canoe']);
    await retainMany(clientWith(ALPHA), ['Alpha owns a bicycle', 'Alpha owns a scooter']);
    await waitForIndexed(subsystemOf(subsystems, 'tenant-1__persona_Beta'), 2);
    await waitForIndexed(subsystemOf(subsystems, 'tenant-1__persona_Alpha'), 2);
    requested.clear();

    // No keyword overlap: only the vector leg can find the hotel, and only in Beta's vault.
    const alphaRecall = await recall(clientWith(ALPHA), 'accommodation in Spain');
    expect([...requested].sort()).toEqual(['tenant-1', 'tenant-1__persona_Alpha']);
    const betaRecall = await recall(clientWith(BETA), 'accommodation in Spain');

    expect(mentions(betaRecall, 'hotel in Porto')).toBe(true);
    expect(mentions(alphaRecall, 'hotel in Porto')).toBe(false);
  });

  it('re-indexes an edited persona fact in that persona store only', async () => {
    const { clientWith, subsystems, requested } = embeddedClients();
    const alpha = clientWith(ALPHA);
    await retainMany(alpha, ['Alpha lodging is a hotel in Lisbon', 'Alpha owns a bicycle']);
    await waitForIndexed(subsystemOf(subsystems, 'tenant-1__persona_Alpha'), 2);
    const [entryId] = await listedIds(alpha, 'persona:Alpha');
    if (entryId === undefined) {
      throw new Error('expected a persona vault entry');
    }
    requested.clear();

    const edited = 'Alpha owns a tent near Sintra';
    await alpha.updateEntry({ entryId, text: edited, timeoutMs: TIMEOUT_MS });

    expect([...requested]).toEqual(['tenant-1__persona_Alpha']);
    await waitFor(async () => {
      const store = await EmbeddingStore.load({ namespaceDir: path.join(baseDir, 'tenant-1__persona_Alpha') });
      return store.get(entryId)?.hash === hashEntryText(edited);
    }, 'the edited fact to be re-indexed');
    expect(await storedIds(TENANT)).toEqual([]);
  });
});
