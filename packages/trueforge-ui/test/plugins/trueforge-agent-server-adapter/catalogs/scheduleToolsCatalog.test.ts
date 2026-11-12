import { describe, expect, it, vi } from 'vitest';

import { createScheduleToolsCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/scheduleToolsCatalog.js';

const WIRE_TOOLS = {
  data: {
    source: 'schedule',
    agent_name: 'assistant-0123',
    connectors: ['calendar'],
    skills: ['digest'],
    sandbox_enabled: true,
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createScheduleToolsCatalog', () => {
  it('GETs the tools of one schedule and maps snake_case wire fields', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://aman.example/api/v1/schedules/sched%201/tools');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
      return json(WIRE_TOOLS);
    });
    const catalog = createScheduleToolsCatalog({ baseUrl: 'https://aman.example/', token: 'secret', fetch: fetchImpl });
    await expect(catalog.getScheduleTools('sched 1')).resolves.toEqual({
      source: 'schedule',
      agentName: 'assistant-0123',
      connectors: ['calendar'],
      skills: ['digest'],
      sandboxEnabled: true,
    });
  });

  it('PUTs the chosen tools with snake_case names', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      expect(init?.body).toBe(JSON.stringify({ connectors: ['calendar'], skills: [], sandbox_enabled: false }));
      return json(WIRE_TOOLS);
    });
    const catalog = createScheduleToolsCatalog({ fetch: fetchImpl });
    await catalog.setScheduleTools({
      scheduleId: 'sched-1',
      tools: { connectors: ['calendar'], skills: [], sandboxEnabled: false },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("raises the server's own message when it refuses", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: 'Skills need the sandbox.' } }, 422));
    const catalog = createScheduleToolsCatalog({ fetch: fetchImpl });
    await expect(
      catalog.setScheduleTools({
        scheduleId: 'sched-1',
        tools: { connectors: [], skills: ['digest'], sandboxEnabled: false },
      }),
    ).rejects.toThrow('Skills need the sandbox.');
  });
});
