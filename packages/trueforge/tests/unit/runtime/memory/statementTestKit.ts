import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COMPARISON_MESSAGES } from '../../../../src/runtime/memory/comparisonMessages';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingModel,
  type EmbeddingModelPhase,
} from '../../../../src/runtime/memory/embeddingModel';
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
    const ask = /ask:(\d):([\d.]+)/.exec(text);
    if (ask !== null) {
      const closeness = Number(ask[2]);
      return unit([
        [TOPIC_AXIS + Number(ask[1]), closeness],
        [1, Math.sqrt(1 - closeness * closeness)],
      ]);
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
