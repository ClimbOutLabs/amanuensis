import { MAIL_CONTENT_TOOL_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import winston from 'winston';

import { DeliveryStore } from '../../../src/db/deliveryStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { NoticingStore } from '../../../src/db/noticingStore';
import { ReachSettingsStore } from '../../../src/db/reachSettingsStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { createDeliveryService } from '../../../src/runtime/delivery/deliveryService';
import { createNoticingService } from '../../../src/runtime/noticing/noticingService';
import {
  imapAgent,
  imapMailboxValidity,
  sidecarMailSource,
  type CallSidecarTool,
  type ListAfterAgent,
} from '../../../src/runtime/noticing/sidecarSources';
import type { MailAccess, MailSource } from '../../../src/runtime/noticing/sources';
import { defaultReachSettings, type NoticingEvent } from '../../../src/schemas/reach';
import { startMailAgent, type MailAgentHarness, type Stored } from './mailAgentSupport';

const OWNER = { tenant_id: 'default', created_by: 'owner-1' };
const NOW = new Date('2026-11-05T15:00:00.000Z');
const PORT = 19776;
const URL = `http://127.0.0.1:${String(PORT)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function imapDate(at: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(at.getUTCDate())}-${MONTHS[at.getUTCMonth()] ?? 'Jan'}-${String(at.getUTCFullYear())} ${two(
    at.getUTCHours(),
  )}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} +0000`;
}

/** The mail connector's tools as noticing uses them: a bill's text, and no later replies. */
const connector: CallSidecarTool = (name, args) => {
  if (name === MAIL_CONTENT_TOOL_NAME) {
    const ids = Array.isArray(args['email_ids']) ? args['email_ids'] : [];
    return Promise.resolve({
      structuredContent: { emails: ids.map(id => ({ email_id: String(id), body: 'Amount due by November 9' })) },
    });
  }
  return Promise.resolve({ structuredContent: { emails: [] } });
};

/**
 * The person's own mail elsewhere, for a switch away from the shared mailbox. It fails to list, so its pass keeps the
 * checkpoint as it found it, and only the switch itself can drop the shared mailbox's cursor.
 */
const otherMail: MailSource = {
  listNewMessages: () => Promise.reject(new Error('The other mail could not be listed.')),
  readText: () => Promise.resolve(''),
  laterInThread: () => Promise.resolve([]),
  trustedAuthenticationServers: [],
};

/**
 * One mailbox on the fake IMAP server, read by the real account agent and the real noticing service, with a clock
 * the test moves. A pass can be made to run out of time after a number of reads or lists.
 */
async function scenario(harness: MailAgentHarness, { delay_ms = 0 }: { delay_ms?: number | undefined } = {}) {
  const clock = { now: NOW };
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const reachSettings = new ReachSettingsStore(db);
  await reachSettings.put({
    ...OWNER,
    settings: {
      ...defaultReachSettings('UTC'),
      noticing_on: true,
      quiet_hours: { enabled: false, start: '21:00', end: '08:00' },
    },
  });
  const store = new NoticingStore(db);
  const recorded: NoticingEvent[] = [];
  const real = store.recordAll.bind(store);
  jest.spyOn(store, 'recordAll').mockImplementation(async input => {
    recorded.push(...input.events);
    return await real(input);
  });
  const deliveryStore = new DeliveryStore(db);
  const deliveries = createDeliveryService({
    store: deliveryStore,
    senders: [{ send: () => Promise.resolve([]) }],
    audit: { record: () => Promise.resolve() },
    logger: winston.createLogger({ silent: true }),
  });
  const box: { uidvalidity: number; messages: (Stored & { name: string })[] } = {
    uidvalidity: 100 + Math.floor(Math.random() * 1_000_000),
    messages: [],
  };
  const stop = { reads: Infinity, lists: Infinity };
  const outOfTime = () => {
    clock.now = new Date(clock.now.getTime() + 61_000);
  };
  const lister = imapAgent({ url: URL, fetchImpl: undefined });
  const agent: ListAfterAgent = async request => {
    const read = await lister(request);
    stop.lists -= 1;
    if (stop.lists === 0) {
      outOfTime();
    }
    return read;
  };
  const imap = sidecarMailSource({
    call: async (name, args) => {
      if (name === MAIL_CONTENT_TOOL_NAME) {
        stop.reads -= 1;
        if (stop.reads === 0) {
          outOfTime();
        }
      }
      return await connector(name, args);
    },
    account: 'default',
    agent,
    validity: imapMailboxValidity({ url: URL, fetchImpl: undefined }),
  });
  let mail: MailAccess = { status: 'ready', source: imap, kind: 'email_connector' };
  const makeService = () =>
    createNoticingService({
      sources: {
        listOwners: () => Promise.resolve([OWNER]),
        sourcesFor: () => Promise.resolve({ mail, calendar: { status: 'none' } }),
      },
      approvals: { listWaiting: () => Promise.resolve([]) },
      reachSettings,
      store,
      deliveries,
      history: deliveryStore,
      judgeFor: () => Promise.resolve(() => Promise.resolve({ level: 'note', reason: 'It can wait.', message: 'Ok.' })),
      budget: { isExhausted: () => Promise.resolve(false) },
      channels: () => ({
        texts: { available: false, note: 'Texts are not set up yet.' },
        calls: { available: false, note: 'Phone calls are not set up yet.' },
      }),
      logger: winston.createLogger({ silent: true }),
      now: () => clock.now,
      sleep: () => Promise.resolve(),
      timezoneFor: () => Promise.resolve('UTC'),
      assistantNameFor: () => Promise.resolve('Mira'),
    });
  let service = makeService();
  const write = () => {
    harness.setMailbox({ uidvalidity: box.uidvalidity, messages: box.messages, fetch_delay_ms: delay_ms });
  };
  return {
    /** A message that arrived at `at`, a bill unless `plain`. */
    put(name: string, at: Date, { plain = false }: { plain?: boolean } = {}) {
      const uid = Math.max(0, ...box.messages.map(message => message.uid)) + 1;
      const subject = plain ? `Note ${name}` : `Invoice ${name}: amount due by November 9`;
      box.messages.push({
        name,
        uid,
        internal_date: imapDate(at),
        header: [
          'From: Power Co <billing@power.test>',
          `Subject: ${subject}`,
          `Date: ${at.toUTCString()}`,
          `Message-ID: <${name}@power.test>`,
        ].join('\n'),
      });
    },
    remove(names: string[]) {
      box.messages = box.messages.filter(message => !names.includes(message.name));
    },
    /** The mailbox is rebuilt: what it holds is numbered again from 1. */
    renumber() {
      box.uidvalidity += 1;
      box.messages = box.messages.map((message, index) => ({ ...message, uid: index + 1 }));
    },
    at(minutes: number) {
      clock.now = new Date(NOW.getTime() + minutes * 60_000);
    },
    stopAfter({ reads = Infinity, lists = Infinity }: { reads?: number; lists?: number }) {
      stop.reads = reads;
      stop.lists = lists;
    },
    /** The app starts again: a new service on the same store. */
    restart() {
      service = makeService();
    },
    useOtherMail() {
      mail = { status: 'ready', source: otherMail, kind: 'google' };
    },
    useSharedMailbox() {
      mail = { status: 'ready', source: imap, kind: 'email_connector' };
    },
    async pass() {
      write();
      await service.run({ watcher: 'mail' });
      stop.reads = Infinity;
      stop.lists = Infinity;
    },
    /** Each bill raised, by name, with how many different events it was raised under. */
    raised(): Record<string, number> {
      const ids: Record<string, Set<string>> = {};
      for (const event of recorded.filter(item => item.id.startsWith('bill_due:'))) {
        const name = /Invoice ([^:]+):/.exec(event.summary)?.[1] ?? event.id;
        (ids[name] ??= new Set()).add(event.id);
      }
      return Object.fromEntries(Object.entries(ids).map(([name, set]) => [name, set.size]));
    },
  };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;
const minutesFrom = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const OLD = new Date('2026-11-02T10:00:00.000Z');

/** Every place a cursor is saved, carried or resumed, with the bills that must each be raised exactly once. */
const ROWS: {
  name: string;
  delay_ms?: number;
  steps: (mail: Scenario) => Promise<void>;
  raised: string[];
}[] = [
  {
    name: 'a first check dates the mail already there, so an old bill moved into the inbox is not new',
    steps: async mail => {
      mail.put('old', OLD);
      mail.put('new', minutesFrom(-5));
      await mail.pass();
    },
    raised: ['new'],
  },
  {
    name: 'a first check the agent cannot finish in one call holds the rest to the same time',
    delay_ms: 1500,
    steps: async mail => {
      for (let n = 0; n < 450; n += 1) {
        mail.put(`old${String(n)}`, new Date('2026-11-05T10:00:00.000Z'));
      }
      for (const name of ['n1', 'n2', 'n3']) mail.put(name, minutesFrom(-5));
      await mail.pass();
    },
    raised: ['n1', 'n2', 'n3'],
  },
  {
    name: 'a pass that stops at a dated message keeps the dating on the cursor it saves',
    steps: async mail => {
      mail.put('n1', minutesFrom(-8));
      mail.put('n2', minutesFrom(-6));
      mail.put('old', OLD);
      mail.stopAfter({ reads: 1 });
      await mail.pass();
      mail.at(10);
      await mail.pass();
    },
    raised: ['n1', 'n2'],
  },
  {
    name: 'a renumbering lists from a little before the last pass and raises nothing twice',
    steps: async mail => {
      mail.put('a', minutesFrom(-5));
      await mail.pass();
      // Moved in after that pass, dated 30 seconds before it.
      mail.put('b', new Date(NOW.getTime() - 30_000));
      mail.renumber();
      mail.at(10);
      await mail.pass();
    },
    raised: ['a', 'b'],
  },
  {
    name: 'a restart in the middle of a first check goes on with the same dating',
    delay_ms: 1500,
    steps: async mail => {
      for (let n = 0; n < 450; n += 1) {
        mail.put(`old${String(n)}`, new Date('2026-11-05T10:00:00.000Z'));
      }
      for (const name of ['n1', 'n2', 'n3']) mail.put(name, minutesFrom(-5));
      mail.stopAfter({ lists: 1 });
      await mail.pass();
      mail.restart();
      mail.at(10);
      await mail.pass();
    },
    raised: ['n1', 'n2', 'n3'],
  },
  {
    name: 'mail moved back from an archive after the cursor is new to the inbox, whatever its date',
    steps: async mail => {
      mail.put('a', minutesFrom(-5));
      await mail.pass();
      mail.put('archived', OLD);
      mail.at(10);
      await mail.pass();
    },
    raised: ['a', 'archived'],
  },
  {
    name: 'deletions leave the cursor naming UIDs, so no new mail is missed',
    steps: async mail => {
      mail.put('a', minutesFrom(-6));
      mail.put('b', minutesFrom(-5));
      mail.put('filler', minutesFrom(-4), { plain: true });
      await mail.pass();
      mail.remove(['a']);
      mail.put('c1', minutesFrom(5));
      mail.put('c2', minutesFrom(6));
      mail.at(10);
      await mail.pass();
    },
    raised: ['a', 'b', 'c1', 'c2'],
  },
  {
    name: 'a switch to other mail and back drops the cursor, even when the other mail failed, and dates the mailbox again',
    steps: async mail => {
      mail.put('a', minutesFrom(-5));
      await mail.pass();
      mail.useOtherMail();
      mail.at(10);
      await mail.pass();
      mail.put('b', minutesFrom(12));
      mail.put('moved', OLD);
      mail.useSharedMailbox();
      mail.at(20);
      await mail.pass();
    },
    raised: ['a', 'b'],
  },
  {
    name: 'a cursor from before the day limit is dropped, and mail is dated from the limit',
    steps: async mail => {
      mail.put('a', minutesFrom(-5));
      await mail.pass();
      mail.put('early', minutesFrom(60));
      mail.put('late', minutesFrom(47 * 60));
      mail.at(48 * 60);
      await mail.pass();
    },
    raised: ['a', 'late'],
  },
];

describe('the IMAP cursor through every way a pass starts, stops and resumes', () => {
  let harness: MailAgentHarness | undefined;

  beforeAll(async () => {
    harness = await startMailAgent({ port: PORT, password: 'CANARY-EDGE-PASSWORD-7r3p', list_seconds: 2 });
  }, 60_000);

  afterAll(() => {
    harness?.stop();
  });

  it.each(ROWS)(
    '$name',
    async ({ steps, delay_ms, raised }) => {
      if (harness === undefined) {
        throw new Error('The mail agent did not start.');
      }
      const mail = await scenario(harness, { delay_ms });
      await steps(mail);
      expect(mail.raised()).toEqual(Object.fromEntries(raised.map(name => [name, 1])));
    },
    120_000,
  );
});
