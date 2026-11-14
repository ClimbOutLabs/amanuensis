import type { AgentContextProcessorOutput, ContextMessage } from '@truefoundry/trueforge-core/core';
import { InternalEventType, type WebSearchTurnState } from '@truefoundry/trueforge-core/core';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';

import type { EmbeddingModel } from '../../../../src/runtime/memory/embeddingModel';
import { EmbeddingSubsystem } from '../../../../src/runtime/memory/embeddingRetrieval';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { memoryCapability } from '../../../../src/runtime/memory/memoryCapability';
import {
  DRAFTING_HEADING,
  NOT_CONFIRMED_TRAILER,
  PAGE_HEADER_START,
  UNCONFIRMED_LABEL,
} from '../../../../src/runtime/memory/memoryPageLoader';
import { PageSectionSchema } from '../../../../src/runtime/memory/memoryPages';
import { serverMemoryConfig } from '../../../../src/runtime/memory/memorySettings';
import { TurnReadWatch } from '../../../../src/runtime/memory/turnReadWatch';
import { MAYA_NAMESPACE } from './buildVault';
import { MAYA_ENTRIES } from './entries';
import type { RecallQuestion } from './schema';

/** Notes older than this many days are the ones recall used to lose, so the scorecard shows them apart. */
const OLD_ANSWER_DAYS = 14;

/** What one question got back, and how it scored. */
export interface RecallAnswer {
  question: RecallQuestion;
  /** The memory block the model would be shown, or an empty string when there is none. */
  block: string;
  /**
   * Whether the expected text is in the block, or every string of the question's page wording is;
   * undefined when the question expects nothing.
   */
  found: boolean | undefined;
  /**
   * Whether something that should stay out is shown as current: the stale or unwanted text the question
   * names, or any memory at all when the message has nothing to recall. Undefined when neither applies.
   */
  unwanted: boolean | undefined;
  /** Days between the newest entry that holds the answer and the day of asking; undefined when the vault holds no answer. */
  answerAgeDays: number | undefined;
}

function holds({ block, text }: { block: string; text: string }): boolean {
  return block.toLowerCase().includes(text.toLowerCase());
}

function answerAgeDays(question: RecallQuestion): number | undefined {
  const days = question.source_entry_ids.flatMap(id => {
    const eventDay = /^event:(\d+)$/.exec(id)?.[1];
    const day = eventDay === undefined ? MAYA_ENTRIES.find(entry => entry.id === id)?.day : Number(eventDay);
    return day === undefined ? [] : [day];
  });
  return days.length === 0 ? undefined : question.as_of_day - Math.max(...days);
}

const EARLIER_LABEL = `${PageSectionSchema.enum.Earlier}:`;
const UNCONFIRMED_LINE = `${UNCONFIRMED_LABEL}:`;
const MEMORY_NOTES_START = '(memory:';

type PageRegion = 'current' | 'earlier' | 'unconfirmed';

/** The part of a bullet in its last brackets, where a page line says where it came from. */
function closingBrackets(line: string): string {
  const open = line.lastIndexOf('(');
  return open === -1 ? '' : line.slice(open);
}

/**
 * Whether the block shows the text as current. A line on a page counts when it sits outside the
 * `Earlier` and unconfirmed parts and does not say it is not confirmed. A line outside every page, such as
 * a note from the daily log, always counts: a note carries no sign that it is out of date.
 */
function shownAsCurrent({ block, text }: { block: string; text: string }): boolean {
  const wanted = text.toLowerCase();
  let inPage = false;
  let region: PageRegion = 'current';
  for (const line of block.split('\n')) {
    if (line.startsWith(PAGE_HEADER_START)) {
      inPage = true;
      region = 'current';
    } else if (line.startsWith('[') || line.startsWith(MEMORY_NOTES_START) || line === DRAFTING_HEADING) {
      inPage = false;
    } else if (inPage) {
      if (line === EARLIER_LABEL) {
        region = 'earlier';
      } else if (line === UNCONFIRMED_LINE) {
        region = 'unconfirmed';
      } else if (!line.startsWith('- ')) {
        region = 'current';
      }
    }
    if (line.toLowerCase().includes(wanted)) {
      if (!inPage) {
        return true;
      }
      if (region === 'current' && !closingBrackets(line).includes(NOT_CONFIRMED_TRAILER)) {
        return true;
      }
    }
  }
  return false;
}

function answerFound({ block, question }: { block: string; question: RecallQuestion }): boolean | undefined {
  if (question.expected_text === undefined) {
    return undefined;
  }
  return (
    holds({ block, text: question.expected_text }) ||
    (question.page_wording?.every(text => holds({ block, text })) ?? false)
  );
}

/** How a memory block scores against a question: whether the answer is shown, and whether something unwanted is shown as current. */
export function judgeBlock({
  block,
  question,
}: {
  block: string;
  question: RecallQuestion;
}): Pick<RecallAnswer, 'found' | 'unwanted'> {
  return { found: answerFound({ block, question }), unwanted: unwantedShown({ block, question }) };
}

function unwantedShown({ block, question }: { block: string; question: RecallQuestion }): boolean | undefined {
  if (question.category === 'nothing_to_recall') {
    return block !== '';
  }
  return question.must_not_text === undefined ? undefined : shownAsCurrent({ block, text: question.must_not_text });
}

function memoryBlockOf(events: AgentContextProcessorOutput[]): string {
  for (const event of events) {
    if (event.type === InternalEventType.PASSTHROUGH && event.event.type === 'aman.memory.recall') {
      return event.event.injected_block ?? '';
    }
  }
  throw new Error('The memory step did not report what it showed the model.');
}

const WARM_TIMEOUT_MS = 15_000;
const WARM_POLL_MS = 20;

/**
 * A meaning search over the vault under `dir`, built on `model` and ready to use. Make a new one for each
 * question, after the vault for that day is written, so it indexes what the day added.
 */
export async function warmEmbeddings({
  dir,
  model,
}: {
  dir: string;
  model: EmbeddingModel;
}): Promise<EmbeddingSubsystem> {
  const subsystem = new EmbeddingSubsystem({
    baseDir: dir,
    namespace: MAYA_NAMESPACE,
    // Never read: the model is given.
    modelDir: path.join(tmpdir(), 'maya-embedding-model'),
    batchSize: 64,
    model,
  });
  subsystem.ensureWarmed();
  // `performance` keeps real time while the test fakes the calendar.
  const startedAt = performance.now();
  while (subsystem.getStatus().state !== 'ready') {
    if (performance.now() - startedAt > WARM_TIMEOUT_MS) {
      throw new Error(`The meaning search was not ready after 15 seconds: ${subsystem.getStatus().detail}`);
    }
    await new Promise(resolve => setTimeout(resolve, WARM_POLL_MS));
  }
  return subsystem;
}

/**
 * Runs the step that builds the memory block before every reply, in a new chat against the vault under
 * `dir`, and returns the block, or an empty string when none is shown. The caller sets the clock to the day
 * of asking.
 */
export async function memoryBlockFor({
  dir,
  message,
  earlierMessages,
  chatId,
  embeddings,
  webSearch,
  watch,
}: {
  dir: string;
  message: string;
  earlierMessages: readonly string[];
  chatId: string;
  /** A warm meaning search for this vault; left out, memory is found by words only. */
  embeddings?: EmbeddingSubsystem | undefined;
  /** The chat's search state, which keeps where each recalled link and address came from. */
  webSearch?: WebSearchTurnState | undefined;
  /** The turn's watch for outside text, which the page tools consult before they write. */
  watch?: TurnReadWatch | undefined;
}): Promise<string> {
  const capability = memoryCapability({
    client: new MarkdownMemoryClient({
      baseDir: dir,
      namespace: MAYA_NAMESPACE,
      ...(embeddings === undefined ? {} : { embeddings: () => embeddings }),
    }),
    config: serverMemoryConfig(),
    logger: winston.createLogger({ silent: true }),
    sessionId: chatId,
    previousTurnId: null,
    timeZone: 'UTC',
    webSearch,
    pageToolsWatch: watch,
  });
  const processor = capability.preLLMProcessors?.[0];
  if (processor === undefined) {
    throw new Error('The memory capability has no step that runs before the model.');
  }
  const context: ContextMessage[] = [
    ...earlierMessages.flatMap((content): ContextMessage[] => [
      { role: 'user', content },
      { role: 'assistant', content: 'OK.' },
    ]),
    { role: 'user', content: message },
  ];
  const events: AgentContextProcessorOutput[] = [];
  for await (const event of processor.processPreLLM({
    threadId: 'main',
    currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    context,
  })) {
    events.push(event);
  }
  return memoryBlockOf(events);
}

/** Asks one question in a new chat against the vault under `dir`. The caller sets the clock to the day of asking. */
export async function askMemory({
  dir,
  question,
  embeddings,
}: {
  dir: string;
  question: RecallQuestion;
  embeddings?: EmbeddingSubsystem | undefined;
}): Promise<RecallAnswer> {
  const block = await memoryBlockFor({
    dir,
    message: question.message,
    earlierMessages: question.earlier_messages,
    chatId: `ask-${question.id}`,
    embeddings,
  });
  return {
    question,
    block,
    ...judgeBlock({ block, question }),
    answerAgeDays: answerAgeDays(question),
  };
}

/** One line of the scorecard: how many questions of a group had their answer shown, and shown cleanly. */
export interface RecallScore {
  group: string;
  questions: number;
  /** Questions whose expected text was shown, out of those that expect one. */
  found: number;
  expectsText: number;
  /** Questions where something that should stay out was shown, out of those that have such a thing. */
  unwanted: number;
  namesUnwanted: number;
  /** Questions with everything expected shown and nothing unwanted shown. */
  clean: number;
}

function scoreOf({ group, answers }: { group: string; answers: readonly RecallAnswer[] }): RecallScore {
  return {
    group,
    questions: answers.length,
    found: answers.filter(answer => answer.found === true).length,
    expectsText: answers.filter(answer => answer.found !== undefined).length,
    unwanted: answers.filter(answer => answer.unwanted === true).length,
    namesUnwanted: answers.filter(answer => answer.unwanted !== undefined).length,
    clean: answers.filter(answer => answer.found !== false && answer.unwanted !== true).length,
  };
}

/** The scorecard: every question together, then by how old the answer is, then by category. */
export function recallScorecard(answers: readonly RecallAnswer[]): RecallScore[] {
  const categories = [...new Set(answers.map(answer => answer.question.category))];
  return [
    scoreOf({ group: 'all', answers }),
    scoreOf({
      group: `answer at most ${String(OLD_ANSWER_DAYS)} days old`,
      answers: answers.filter(answer => answer.answerAgeDays !== undefined && answer.answerAgeDays <= OLD_ANSWER_DAYS),
    }),
    scoreOf({
      group: `answer more than ${String(OLD_ANSWER_DAYS)} days old`,
      answers: answers.filter(answer => answer.answerAgeDays !== undefined && answer.answerAgeDays > OLD_ANSWER_DAYS),
    }),
    ...categories.map(category =>
      scoreOf({ group: category, answers: answers.filter(answer => answer.question.category === category) }),
    ),
  ];
}
