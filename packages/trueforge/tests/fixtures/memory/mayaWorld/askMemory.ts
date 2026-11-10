import type { AgentContextProcessorOutput, ContextMessage } from '@truefoundry/trueforge-core/core';
import { InternalEventType } from '@truefoundry/trueforge-core/core';
import winston from 'winston';

import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { hindsightMemoryCapability } from '../../../../src/runtime/memory/memoryCapability';
import { serverMemoryConfig } from '../../../../src/runtime/memory/memorySettings';
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
  /** Whether the expected text is in the block; undefined when the question expects nothing. */
  found: boolean | undefined;
  /**
   * Whether something that should stay out is in the block: the stale or unwanted text the question
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

function unwantedShown({ block, question }: { block: string; question: RecallQuestion }): boolean | undefined {
  if (question.category === 'nothing_to_recall') {
    return block !== '';
  }
  return question.must_not_text === undefined ? undefined : holds({ block, text: question.must_not_text });
}

function memoryBlockOf(events: AgentContextProcessorOutput[]): string {
  for (const event of events) {
    if (event.type === InternalEventType.PASSTHROUGH && event.event.type === 'aman.memory.recall') {
      return event.event.injected_block ?? '';
    }
  }
  throw new Error('The memory step did not report what it showed the model.');
}

/**
 * Asks one question in a new chat against the vault under `dir`, through the same step that builds the
 * memory block before every reply. The caller sets the clock to the day of asking.
 */
export async function askMemory({ dir, question }: { dir: string; question: RecallQuestion }): Promise<RecallAnswer> {
  const capability = hindsightMemoryCapability({
    client: new MarkdownMemoryClient({ baseDir: dir, namespace: MAYA_NAMESPACE }),
    config: serverMemoryConfig(),
    logger: winston.createLogger({ silent: true }),
    sessionId: `ask-${question.id}`,
    previousTurnId: null,
    timeZone: 'UTC',
  });
  const processor = capability.preLLMProcessors?.[0];
  if (processor === undefined) {
    throw new Error('The memory capability has no step that runs before the model.');
  }
  const context: ContextMessage[] = [
    ...question.earlier_messages.flatMap((content): ContextMessage[] => [
      { role: 'user', content },
      { role: 'assistant', content: 'OK.' },
    ]),
    { role: 'user', content: question.message },
  ];
  const events: AgentContextProcessorOutput[] = [];
  for await (const event of processor.processPreLLM({
    threadId: 'main',
    currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    context,
  })) {
    events.push(event);
  }
  const block = memoryBlockOf(events);
  return {
    question,
    block,
    found: question.expected_text === undefined ? undefined : holds({ block, text: question.expected_text }),
    unwanted: unwantedShown({ block, question }),
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
