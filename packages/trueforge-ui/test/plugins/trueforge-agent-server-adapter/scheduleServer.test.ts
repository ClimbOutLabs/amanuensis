import { describe, expect, it, vi } from 'vitest';

import { createScheduleServer } from '@/plugins/trueforge-agent-server-adapter/schedules/scheduleServer.js';
import type { TrueForge } from '@truefoundry/trueforge-sdk';

function mockClient(
  overrides: {
    agents?: Array<{ id: string; name: string }>;
    list?: ReturnType<typeof vi.fn>;
    listRuns?: ReturnType<typeof vi.fn>;
    createRun?: ReturnType<typeof vi.fn>;
  } = {},
): TrueForge {
  const agents = overrides.agents ?? [
    { id: 'a1', name: 'alpha' },
    { id: 'a2', name: 'beta' },
  ];
  const list =
    overrides.list ??
    vi.fn(async () => ({
      data: [
        {
          id: 's1',
          name: 'job',
          agentName: 'alpha',
          runsAs: 'Bender',
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          createdBySubject: {
            subjectId: 'user-1',
            subjectType: 'user',
            subjectDisplayName: 'alice@example.com',
          },
          manifest: {
            task: 'do thing',
            cron: '0 9 * * *',
            timezone: 'UTC',
            status: 'paused' as const,
          },
        },
      ],
      response: { pagination: { limit: 25, nextPageToken: 'next-1' } },
      hasNextPage: () => true,
      getNextPage: async () => undefined,
    }));

  return {
    agents: {
      list: vi.fn(async () => ({
        data: agents,
        response: { pagination: { limit: 25 } },
        hasNextPage: () => false,
        getNextPage: async () => undefined,
      })),
    },
    schedules: {
      list,
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      listRuns: overrides.listRuns ?? vi.fn(),
      createRun: overrides.createRun ?? vi.fn(),
    },
  } as unknown as TrueForge;
}

describe('createScheduleServer.listSchedules', () => {
  it('maps agentIds to agentNames CSV and returns ListResult pagination', async () => {
    const list = vi.fn(async () => ({
      data: [
        {
          id: 's1',
          name: 'job',
          agentName: 'alpha',
          runsAs: 'Bender',
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          createdBySubject: {
            subjectId: 'user-1',
            subjectType: 'user',
            subjectDisplayName: 'alice@example.com',
          },
          manifest: {
            task: 'do thing',
            cron: '0 9 * * *',
            timezone: 'UTC',
            status: 'paused' as const,
          },
        },
      ],
      response: { pagination: { limit: 10, nextPageToken: 'tok' } },
      hasNextPage: () => true,
      getNextPage: async () => undefined,
    }));
    const server = createScheduleServer({ client: mockClient({ list }) });

    const page = await server.listSchedules({ agentIds: ['a1', 'a2'], limit: 10, pageToken: 'prev' });

    expect(list).toHaveBeenCalledWith({
      limit: 10,
      pageToken: 'prev',
      agentNames: 'alpha,beta',
    });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.agentId).toBe('a1');
    expect(page.data[0]?.runsAs).toBe('Bender');
    expect(page.data[0]?.status).toBe('paused');
    expect(page.data[0]?.createdBySubject).toEqual({
      subjectId: 'user-1',
      subjectType: 'user',
      subjectDisplayName: 'alice@example.com',
    });
    expect(page.nextPageToken).toBe('tok');
  });

  it('resolves a schedule made in a chat, whose agent the agents list leaves out', async () => {
    const list = vi.fn(async () => ({
      data: [
        {
          id: 's2',
          name: 'lobster-joke',
          agentName: 'assistant-0123456789abcdef',
          runsAs: 'Bender',
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          createdBySubject: { subjectId: 'user-1', subjectType: 'user', subjectDisplayName: 'alice@example.com' },
          manifest: { task: 'Tell me a lobster joke.', cron: '0 8 * * *', timezone: 'UTC', status: 'active' as const },
        },
      ],
      response: { pagination: { limit: 25 } },
      hasNextPage: () => false,
      getNextPage: async () => undefined,
    }));
    const server = createScheduleServer({ client: mockClient({ list }) });

    const page = await server.listSchedules({});
    const [schedule] = page.data;
    expect(schedule).toMatchObject({ agentId: 'assistant-0123456789abcdef', runsAs: 'Bender' });

    await expect(server.listSchedules({ agentIds: [schedule?.agentId ?? ''] })).resolves.toMatchObject({
      data: [{ runsAs: 'Bender' }],
    });
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ agentNames: 'assistant-0123456789abcdef' }));
  });

  it('caps limit at 25', async () => {
    const list = vi.fn(async () => ({
      data: [],
      response: { pagination: { limit: 25 } },
      hasNextPage: () => false,
      getNextPage: async () => undefined,
    }));
    const server = createScheduleServer({ client: mockClient({ list }) });
    await server.listSchedules({ limit: 100 });
    expect(list).toHaveBeenCalledWith({ limit: 25 });
  });
});

describe('createScheduleServer schedule runs', () => {
  const wireRun = {
    id: 'run-1',
    scheduleId: 's1',
    name: 'manual-abc',
    scheduledFor: new Date('2024-06-01T12:00:00.000Z'),
    status: 'triggered' as const,
    triggeredAt: new Date('2024-06-01T12:00:01.000Z'),
    createdBySubject: {
      subjectId: 'alice',
      subjectType: 'user',
      subjectDisplayName: 'alice',
    },
    createdAt: new Date('2024-06-01T12:00:00.000Z'),
    updatedAt: new Date('2024-06-01T12:00:01.000Z'),
  };

  it('maps listScheduleRuns from SDK listRuns', async () => {
    const listRuns = vi.fn(async () => ({ data: [wireRun] }));
    const server = createScheduleServer({ client: mockClient({ listRuns }) });
    const runs = await server.listScheduleRuns({ scheduleId: 's1' });
    expect(listRuns).toHaveBeenCalledWith('s1');
    expect(runs).toEqual([
      {
        id: 'run-1',
        scheduleId: 's1',
        name: 'manual-abc',
        scheduledFor: '2024-06-01T12:00:00.000Z',
        status: 'triggered',
        triggeredAt: '2024-06-01T12:00:01.000Z',
        triggeredBy: 'alice',
      },
    ]);
  });

  it('maps createScheduleRun from SDK createRun', async () => {
    const createRun = vi.fn(async () => ({ data: wireRun }));
    const server = createScheduleServer({ client: mockClient({ createRun }) });
    const run = await server.createScheduleRun({ scheduleId: 's1' });
    expect(createRun).toHaveBeenCalledWith({ scheduleId: 's1' });
    expect(run.id).toBe('run-1');
    expect(run.triggeredAt).toBe('2024-06-01T12:00:01.000Z');
  });
});

describe('createScheduleServer.listSchedules with one-time schedules and reminders', () => {
  function row(id: string, manifest: Record<string, unknown>) {
    return {
      id,
      name: id,
      agentName: 'alpha',
      runsAs: 'Bender',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      createdBySubject: { subjectId: 'user-1', subjectType: 'user', subjectDisplayName: 'alice@example.com' },
      manifest: { task: 'do thing', timezone: 'UTC', status: 'active', ...manifest },
    };
  }

  it('lists repeating tasks only: a one-time schedule or a reminder is not edited as a task', async () => {
    const list = vi.fn(async () => ({
      data: [
        row('repeating', { cron: '0 9 * * *' }),
        row('once', { cron: null, runAt: '2026-10-26T18:00:00-04:00' }),
        row('repeating-reminder', { cron: '0 9 * * *', kind: 'reminder' }),
      ],
      response: { pagination: { limit: 25 } },
      hasNextPage: () => false,
      getNextPage: async () => undefined,
    }));
    const server = createScheduleServer({ client: mockClient({ list }) });
    const result = await server.listSchedules();
    expect(result.data.map(schedule => schedule.id)).toEqual(['repeating']);
  });
});
