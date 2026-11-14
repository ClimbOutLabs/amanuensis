import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COMPARISON_MESSAGES } from '../../../../src/runtime/memory/comparisonMessages';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingModel,
  type EmbeddingModelPhase,
} from '../../../../src/runtime/memory/embeddingModel';
import { EmbeddingSubsystem } from '../../../../src/runtime/memory/embeddingRetrieval';
import { appendHandledNote, type HandledOutcome } from '../../../../src/runtime/memory/handledNotes';
import { formatRetainEntry, scanNamespaceEntries } from '../../../../src/runtime/memory/markdownMemoryFiles';
import { computeMeaningGate, type MeaningGate } from '../../../../src/runtime/memory/meaningGate';
import type { RetainItem } from '../../../../src/runtime/memory/memoryClient';
import {
  NOTE_DATE_METADATA_KEY,
  NOTE_SOURCE_METADATA_KEY,
  noteRetainContent,
} from '../../../../src/runtime/memory/memoryNotes';
import {
  MEMORY_ORIGIN_METADATA_KEY,
  TOOL_INGESTED_ORIGIN,
  USER_STATED_ORIGIN,
} from '../../../../src/runtime/memory/memoryOrigin';
import type { PageKind } from '../../../../src/runtime/memory/memoryPages';
import { writePageFile } from './pageFixtures';

const TOPIC_AXIS = 10;
const TOPICS = 6;

function unit(parts: readonly [number, number][]): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const [axis, value] of parts) {
    vector[axis] = value;
  }
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map(value => value / length);
}

/** A query that sits at closeness `closeness` (0 to 1) to the statements about topic `topic`. */
export function askAbout({ topic, closeness }: { topic: number; closeness: number }): string {
  return `ask:${String(topic)}:${String(closeness)}`;
}

/** A query about two topics at once, at the given closeness to each; the squares of the closeness must add up to 1 or less. */
export function askAboutBoth({ first, second }: { first: [number, number]; second: [number, number] }): string {
  return `${askAbout({ topic: first[0], closeness: first[1] })}+${askAbout({ topic: second[0], closeness: second[1] })}`;
}

/**
 * A model whose vectors are chosen by hand. A passage that holds `topicN` sits on axis N. Each comparison
 * message leans a different amount towards every topic, and the first `hot` of them lean hard towards one,
 * so some statements have ordinary messages that come close. Any other text points away from everything.
 */
export class HandChosenModel extends EmbeddingModel {
  ready = true;
  /** Every passage the model was asked to embed, in order. */
  readonly passages: string[] = [];
  private readonly comparisonIndex = new Map(COMPARISON_MESSAGES.map((text, index) => [text, index]));

  constructor(private readonly hot = 0) {
    super({ modelDir: path.join(tmpdir(), 'hand-chosen-model') });
  }

  override get currentPhase(): EmbeddingModelPhase {
    return this.ready ? 'ready' : 'idle';
  }

  override ensureReady(): Promise<boolean> {
    return Promise.resolve(this.ready);
  }

  override embedQueries(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(text => this.queryVector(text)));
  }

  override embedPassages(texts: string[]): Promise<number[][]> {
    this.passages.push(...texts);
    return Promise.resolve(
      texts.map(text => {
        const topic = /topic(\d)/.exec(text)?.[1];
        return unit([[topic === undefined ? 100 : TOPIC_AXIS + Number(topic), 1]]);
      }),
    );
  }

  private queryVector(text: string): number[] {
    const asks = [...text.matchAll(/ask:(\d):([\d.]+)/g)];
    if (asks.length > 0) {
      const parts: [number, number][] = asks.map(ask => [TOPIC_AXIS + Number(ask[1]), Number(ask[2])]);
      const used = parts.reduce((sum, [, closeness]) => sum + closeness * closeness, 0);
      return unit([...parts, [1, Math.sqrt(Math.max(0, 1 - used))]]);
    }
    const index = this.comparisonIndex.get(text);
    if (index === undefined) {
      return unit([[101, 1]]);
    }
    const lean = ((index * 37) % 101) / 100;
    const parts: [number, number][] = [[0, 1]];
    for (let topic = 0; topic < TOPICS; topic += 1) {
      parts.push([TOPIC_AXIS + topic, 0.3 * lean]);
    }
    if (index < this.hot) {
      parts.push([TOPIC_AXIS + (index % TOPICS), 1.5]);
    }
    return unit(parts);
  }
}

export async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'statement-index-'));
}

/** A person page with a summary line and the given bullets under Now, in the page's own format. */
export async function writeStatementPage({
  vaultDir,
  slug,
  title,
  summary,
  sections,
  kind = 'person',
}: {
  vaultDir: string;
  slug: string;
  title: string;
  summary?: string;
  /** Section name to the bullet lines under it, markers included. */
  sections: Record<string, string[]>;
  kind?: PageKind;
}): Promise<void> {
  const body = Object.entries(sections).flatMap(([name, bullets]) => [`## ${name}`, ...bullets, '']);
  const status = kind === 'person' ? 'household: false' : 'status: active';
  const content = [
    '---',
    `kind: ${kind}`,
    `title: ${title}`,
    `aliases: [${title}]`,
    status,
    '---',
    `# ${title}`,
    '',
    ...(summary === undefined ? [] : [summary, '']),
    ...body,
  ].join('\n');
  await writePageFile({ vaultDir, kind, slug, content });
}

/** A confirmed bullet from the person's own words. */
export function ownBullet({ text, id, until }: { text: string; id: string; until?: string }): string {
  return `- ${text} <!-- fact: id=${id} src=you_said since=2026-01-01${until === undefined ? '' : ` until=${until}`} -->`;
}

/** The folder a vault made by `makeVault` is read from: its parent is the base folder, its name the namespace. */
function vaultParts(vaultDir: string): { baseDir: string; namespace: string } {
  return { baseDir: path.dirname(vaultDir), namespace: path.basename(vaultDir) };
}

/**
 * A note saved to a vault's daily log, in the format the log uses. A note from the person has no `source`;
 * one read from mail or a page does, and is dated by its day.
 */
export interface KitNote {
  /** The day's file, `YYYY-MM-DD`. */
  day: string;
  text: string;
  source?: 'email' | 'web';
}

/** Appends notes to the daily files of a vault. Returns their ids, in the order given. */
export async function writeKitNotes({
  vaultDir,
  notes,
}: {
  vaultDir: string;
  notes: readonly KitNote[];
}): Promise<string[]> {
  const { namespace } = vaultParts(vaultDir);
  await mkdir(path.join(vaultDir, 'memory'), { recursive: true });
  const counts = new Map<string, number>();
  const ids: string[] = [];
  for (const note of notes) {
    const before = counts.get(note.day) ?? 0;
    const date = note.day;
    const item: RetainItem = {
      content:
        note.source === undefined ? note.text : noteRetainContent({ text: note.text, source: note.source, date }),
      timestamp: `${date}T09:00:00.000Z`,
      document_id: `kit-${date}-${String(before)}`,
      metadata:
        note.source === undefined
          ? { [MEMORY_ORIGIN_METADATA_KEY]: USER_STATED_ORIGIN }
          : {
              [MEMORY_ORIGIN_METADATA_KEY]: TOOL_INGESTED_ORIGIN,
              [NOTE_SOURCE_METADATA_KEY]: note.source,
              [NOTE_DATE_METADATA_KEY]: date,
            },
    };
    await appendFile(path.join(vaultDir, 'memory', `${date}.md`), `${formatRetainEntry(item)}\n\n`, 'utf8');
    ids.push(`md:${namespace}:${date}.md#${String(before)}`);
    counts.set(note.day, before + 1);
  }
  return ids;
}

/**
 * A meaning search over the vault's daily log, warm and ready (or, with a model that is not ready, left cold).
 * A new one warms from the vectors on disk, so notes written or erased since the last one are reconciled.
 */
export async function warmLog({
  vaultDir,
  model,
}: {
  vaultDir: string;
  model: EmbeddingModel;
}): Promise<EmbeddingSubsystem> {
  const { baseDir, namespace } = vaultParts(vaultDir);
  const embeddings = new EmbeddingSubsystem({
    baseDir,
    namespace,
    modelDir: path.join(tmpdir(), 'hand-chosen-model'),
    batchSize: 64,
    model,
  });
  embeddings.ensureWarmed();
  const startedAt = performance.now();
  while (model.currentPhase === 'ready' && embeddings.getStatus().state !== 'ready') {
    if (performance.now() - startedAt > 15_000) {
      throw new Error(`The meaning search was not ready: ${embeddings.getStatus().detail}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return embeddings;
}

/** The gate of one message over one vault, as a reply would get it, after a fresh warm of the log. */
export async function gateFor({
  vaultDir,
  model,
  message,
  currentSessionId,
}: {
  vaultDir: string;
  model: EmbeddingModel;
  message: string;
  currentSessionId?: string;
}): Promise<MeaningGate> {
  const { baseDir, namespace } = vaultParts(vaultDir);
  const embeddings = await warmLog({ vaultDir, model });
  return computeMeaningGate({
    message,
    vaults: [
      {
        namespace,
        dir: vaultDir,
        scan: await scanNamespaceEntries({
          baseDir,
          namespace,
          maxDailyFiles: Number.POSITIVE_INFINITY,
          resolveTombstones: true,
        }),
        embeddings,
      },
    ],
    currentSessionId,
  });
}

/** Records the same outcome in the vault's list of handled notes for each of the notes. */
export async function markHandled({
  vaultDir,
  ids,
  outcome,
}: {
  vaultDir: string;
  ids: readonly string[];
  outcome: HandledOutcome;
}): Promise<void> {
  for (const noteId of ids) {
    await appendHandledNote({ vaultDir, noteId, outcome });
  }
}
