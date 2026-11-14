import { AgentSpecSchema, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import winston from 'winston';

import type { ScheduleDispatchItem } from '../../../src/db/scheduleStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import {
  BRIEF_READY_FALLBACK_TEXT,
  briefDeliveryId,
  deliverBriefReady,
  isBriefRun,
} from '../../../src/runtime/briefDelivery';
import { createDeliveryService } from '../../../src/runtime/delivery/deliveryService';
import { createWebPushSender } from '../../../src/runtime/delivery/webPushSender';
import { readReachHistory } from '../../../src/runtime/noticing/reachGate';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { ALICE, textsHarness } from '../../fixtures/textsHarness';

const OWNER: CreatedBySubject = { subject_id: ALICE.created_by, subject_type: 'user', subject_display_name: 'Dana' };
const CHAT_ID = 'chat-brief-1';
const DIGEST = 'Two things need you today: a rent reminder and a 3 PM call with Sam.';
const BRIEF_ANSWER = `Here is your brief.\n\n\`\`\`json\n${JSON.stringify({ digest: DIGEST, items: [] })}\n\`\`\``;

async function setup() {
  const h = await textsHarness();
  const logger = winston.createLogger({ silent: true });
  const agentStore = new SqliteAgentStore(h.db);
  const scheduleStore = new SqliteScheduleStore(h.db);
  const agent = await agentStore.createAgent({
    host_managed: true,
    tenant_id: ALICE.tenant_id,
    created_by_subject: OWNER,
    name: 'assistant-0123456789abcdef',
    description: 'Runs the schedules you make in a chat.',
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    external_id: null,
  });

  /** A queued run of a daily schedule, the item the dispatch loop hands over when it is due. */
  async function dueRun({ name, task }: { name: string; task: string }): Promise<ScheduleDispatchItem> {
    const { schedule, pendingRun } = await scheduleStore.createScheduleAndRun({
      tenant_id: ALICE.tenant_id,
      agent_id: agent.id,
      agent_name: agent.name,
      persona_id: null,
      name,
      manifest: ScheduleManifestSchema.parse({ task, cron: '0 7 * * *', timezone: 'UTC' }),
      created_by_subject: OWNER,
      runFrom: new Date('2026-11-06T06:00:00.000Z'),
    });
    if (pendingRun === undefined) {
      throw new Error('Expected the schedule to queue a run');
    }
    return { run: pendingRun, schedule };
  }

  const finish = (item: ScheduleDispatchItem, answer: string, deliveries = h.deliveries) =>
    deliverBriefReady({ item, session_id: CHAT_ID, answer, deliveries, logger });
  const feed = async () => (await h.deliveryStore.list({ ...ALICE, limit: 10 })).deliveries;

  return { h, dueRun, finish, feed };
}

describe('a finished morning brief in the bell', () => {
  it('writes one note with the digest, linked to the brief chat', async () => {
    const { dueRun, finish, feed } = await setup();
    const item = await dueRun({ name: 'morning-brief', task: MORNING_BRIEF_PROMPT });

    await finish(item, BRIEF_ANSWER);

    expect(await feed()).toEqual([
      expect.objectContaining({
        id: briefDeliveryId(item.run.id),
        kind: 'note',
        level: 'note',
        text: DIGEST,
        link: { type: 'chat', session_id: CHAT_ID },
        reason: 'Your morning brief ran on Friday, November 6 at 7:00 AM.',
      }),
    ]);
  });

  it('says the brief is ready when the answer has no digest to show', async () => {
    const { dueRun, finish, feed } = await setup();
    const item = await dueRun({ name: 'morning-brief', task: MORNING_BRIEF_PROMPT });

    await finish(item, 'I could not shape today’s brief, but your calendar is clear.');

    expect((await feed()).map(row => row.text)).toEqual([BRIEF_READY_FALLBACK_TEXT]);
  });

  it('writes nothing for a run that ended with no answer', async () => {
    const { dueRun, finish, feed } = await setup();
    const item = await dueRun({ name: 'morning-brief', task: MORNING_BRIEF_PROMPT });

    await finish(item, '  \n');

    expect(await feed()).toEqual([]);
  });

  it('writes one item when the same run finishes twice', async () => {
    const { dueRun, finish, feed } = await setup();
    const item = await dueRun({ name: 'morning-brief', task: MORNING_BRIEF_PROMPT });

    await finish(item, BRIEF_ANSWER);
    await finish(item, BRIEF_ANSWER);

    expect(await feed()).toHaveLength(1);
  });

  it('is never texted, even with texts switched on', async () => {
    const { h, dueRun, finish, feed } = await setup();
    await h.readyToText();
    const item = await dueRun({ name: 'morning-brief', task: MORNING_BRIEF_PROMPT });

    await finish(item, BRIEF_ANSWER);

    expect(h.sent).toEqual([]);
    expect((await feed())[0]?.attempts.map(attempt => attempt.channel)).toEqual(['in_app']);
  });

  it('is never pushed to a device that has notices on', async () => {
    const { h, dueRun, finish, feed } = await setup();
    const fetchPush = jest.fn(() => Promise.resolve({ status: 201 }));
    const pushing = createDeliveryService({
      store: h.deliveryStore,
      senders: [
        createWebPushSender({
          subscriptions: {
            save: () => Promise.reject(new Error('not used')),
            listTargets: () =>
              Promise.resolve([
                { id: 'phone', endpoint: 'https://push.example.test/a', p256dh: 'p', auth: 'x', server_key: 'pub' },
              ]),
            hasEndpoint: () => Promise.reject(new Error('not used')),
            removeByEndpoint: () => Promise.resolve(false),
            removeById: () => Promise.resolve(false),
          },
          settings: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:owner@example.invalid' },
          fetchPush,
        }),
      ],
      audit: { record: () => Promise.resolve() },
      logger: winston.createLogger({ silent: true }),
    });
    const item = await dueRun({ name: 'morning-brief', task: MORNING_BRIEF_PROMPT });

    await finish(item, BRIEF_ANSWER, pushing);

    expect(fetchPush).not.toHaveBeenCalled();
    expect((await feed())[0]?.attempts.map(attempt => attempt.channel)).toEqual(['in_app']);
  });

  it('does not count toward the day’s nudges', async () => {
    const { h, dueRun, finish } = await setup();
    const item = await dueRun({ name: 'morning-brief', task: MORNING_BRIEF_PROMPT });

    await finish(item, BRIEF_ANSWER);

    const history = await readReachHistory({
      history: h.deliveryStore,
      owner: ALICE,
      timezone: 'UTC',
      now: new Date(),
    });
    expect(history.nudges_today).toBe(0);
  });

  it('leaves the bell to briefs: another schedule is not a brief run', async () => {
    const { dueRun } = await setup();

    expect(isBriefRun(await dueRun({ name: 'morning-brief', task: MORNING_BRIEF_PROMPT }))).toBe(true);
    expect(isBriefRun(await dueRun({ name: 'water-plants', task: 'Remind me to water the plants.' }))).toBe(false);
  });
});
