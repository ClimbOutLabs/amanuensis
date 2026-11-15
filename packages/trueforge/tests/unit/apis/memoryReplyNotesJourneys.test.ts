/**
 * Walks one chat turn into memory through the real server, with a scripted model that would gladly put
 * anything it is shown on a page. Each test reads the memory folder the way the Memory screen does:
 * the saved notes, and the pages about people and matters.
 */
import { z } from '@hono/zod-openapi';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import configuration from '../../../src/config';
import { memoryBackgroundWorkSettled } from '../../../src/runtime/memory/memoryBackgroundWork';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import type { ChatMessage } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Answer the user.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

/** What the person types: one thing worth keeping about someone, and a question. */
const FACT = 'Nora is allergic to shellfish, so we never order prawns for her.';
/** Advice in the reply, long enough to be kept as a note of what Aman said. */
const ADVICE = 'Oat bars travel well, so Nora should keep a few in her bag for the long walk on Sunday.';
const REPLY = `${ADVICE} She should also carry water and stop for a rest every hour on the way up.`;
const ADVICE_WORDS = 'Oat bars';

/** Answers the host's memory requests like a model that keeps every sentence and files every note it is shown. */
function eagerMemoryModel(asked: { sorting: string[] }): (messages: readonly ChatMessage[]) => string {
  return messages => {
    const prompt = JSON.stringify(messages);
    if (prompt.includes('You sort one saved note onto the pages')) {
      asked.sorting.push(prompt);
      const text = prompt.includes(ADVICE_WORDS) ? `Aman said: ${ADVICE}` : FACT;
      return JSON.stringify({
        decisions: [
          { decision: 'new', about: 'nora', page_kind: 'person', title: 'Nora', section: 'Now', text, reason: 'Said.' },
        ],
      });
    }
    if (prompt.includes('what an assistant found and said')) {
      return JSON.stringify({ findings: [], responses: [1, 2] });
    }
    return JSON.stringify({ facts: [FACT] });
  };
}

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe("what Aman itself said in a chat, on the person's memory pages", () => {
  let server: ApprovalTestServer;
  const summarize = configuration.MEMORY_SUMMARIZE;
  const sorting = configuration.MEMORY_PAGE_SORTING;

  beforeEach(async () => {
    configuration.MEMORY_PAGE_SORTING = 'on';
    configuration.MEMORY_SUMMARIZE = true;
    // A server of its own for each test, so each starts with an empty memory.
    server = await startApprovalTestServer({ memoryTidy: true });
  }, 120_000);

  afterEach(async () => {
    configuration.MEMORY_SUMMARIZE = summarize;
    configuration.MEMORY_PAGE_SORTING = sorting;
    await server.close();
  });

  /** Every Markdown file in the memory folder, by its path under the person's own folder. */
  async function memoryFiles(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const file of await readdir(configuration.MEMORY_MARKDOWN_DIR, { recursive: true })) {
      if (file.endsWith('.md')) {
        files.set(
          file.split(/[\\/]/).slice(1).join('/'),
          await readFile(join(configuration.MEMORY_MARKDOWN_DIR, file), 'utf8'),
        );
      }
    }
    return files;
  }

  /** The pages about people and matters: every file that is not a day of saved notes. */
  async function pages(): Promise<Map<string, string>> {
    return new Map([...(await memoryFiles())].filter(([path]) => !path.startsWith('memory/')));
  }

  async function savedNotes(): Promise<string> {
    return [...(await memoryFiles())]
      .filter(([path]) => path.startsWith('memory/'))
      .map(([, text]) => text)
      .join('\n');
  }

  /** The person says the fact and asks; Aman answers with the advice. Returns once the memory work is done. */
  async function chatOnce(): Promise<void> {
    const created = await server.request('/api/v1/sessions', json({ agent: { spec: AGENT_SPEC } }));
    const chatId = z.object({ data: z.object({ id: z.string() }).loose() }).parse(await created.json()).data.id;
    server.model.next({ reply: REPLY });
    const turn = await server.request(
      `/api/v1/sessions/${chatId}/turns`,
      json({
        input: [{ type: 'user.message', content: `${FACT} What should she take on the walk?` }],
        stream: true,
        client_timezone: 'Europe/London',
      }),
    );
    expect(turn.status).toBe(200);
    await turn.text();
    for (let attempt = 0; attempt < 100 && !(await savedNotes()).includes(ADVICE_WORDS); attempt += 1) {
      await delay(100);
    }
    await memoryBackgroundWorkSettled({ timeoutMs: 20_000 });
  }

  /** Presses "Tidy now" on the Memory settings page and waits for the tidy-up to end. */
  async function tidyNow(): Promise<void> {
    const started = await server.request('/api/v1/settings/memory-nightly/run', json({}));
    expect(started.status).toBe(200);
    const RunSchema = z.object({ data: z.object({ status: z.string() }).loose() });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const run = RunSchema.parse(await (await server.request('/api/v1/settings/memory-nightly/run')).json());
      if (run.data.status !== 'busy') {
        expect(run.data.status).toBe('ran');
        return;
      }
      await delay(100);
    }
    throw new Error('The tidy-up did not end.');
  }

  async function expectOnlyThePersonsWordsOnPages(asked: { sorting: string[] }): Promise<void> {
    const found = await pages();
    // One page, about the person the fact names. None is named after Aman or made from its reply.
    expect([...found.keys()]).toEqual(['people/nora.md']);
    expect(found.get('people/nora.md')).toContain(FACT);
    for (const [, text] of found) {
      expect(text).not.toContain(ADVICE_WORDS);
    }
    // The model was never shown the reply to sort, so no answer of its could put it on a page.
    expect(asked.sorting.some(prompt => prompt.includes(ADVICE_WORDS))).toBe(false);
    expect(asked.sorting.length).toBeGreaterThan(0);
    // The reply is still kept as a note, where it can be found again.
    expect(await savedNotes()).toContain(ADVICE);
  }

  it(
    'stays off every page after the chat and after "Tidy now", while the fact the person typed reaches its page',
    async () => {
      const asked: { sorting: string[] } = { sorting: [] };
      server.model.answerHostRequests(eagerMemoryModel(asked));

      await chatOnce();
      await expectOnlyThePersonsWordsOnPages(asked);

      await tidyNow();
      await expectOnlyThePersonsWordsOnPages(asked);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'stays off every page when the chat was saved in full and "Tidy now" sorts it later',
    async () => {
      const asked: { sorting: string[] } = { sorting: [] };
      server.model.answerHostRequests(eagerMemoryModel(asked));
      // With summaries off the whole exchange is saved as it was said, and nothing is sorted yet.
      configuration.MEMORY_SUMMARIZE = false;
      await chatOnce();
      expect(await savedNotes()).toContain(FACT);
      expect([...(await pages()).keys()]).toEqual([]);

      configuration.MEMORY_SUMMARIZE = true;
      await tidyNow();
      await expectOnlyThePersonsWordsOnPages(asked);
    },
    TURN_TIMEOUT_MS,
  );
});
