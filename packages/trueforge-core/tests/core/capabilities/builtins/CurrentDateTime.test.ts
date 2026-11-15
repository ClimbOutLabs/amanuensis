import {
  CurrentDateTime,
  GET_CURRENT_DATETIME_TOOL_NAME,
} from '../../../../src/core/capabilities/builtins/CurrentDateTime';
import { isCallToolResponseResult } from '../../../../src/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';

interface DateTimePayload {
  date: string;
  weekday: string;
  time: string;
  zone: string;
  utcOffset: string;
  zoneIsThePersons: boolean;
  unixEpochMS: number;
}

async function answerText(tool: CurrentDateTime): Promise<string> {
  const response = await tool.callTool({ name: GET_CURRENT_DATETIME_TOOL_NAME, arguments: {} });
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a resolved call_tool response');
  }
  const first = response.result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  return first.text;
}

async function callGetCurrentDateTime(tool: CurrentDateTime): Promise<DateTimePayload> {
  return JSON.parse(await answerText(tool)) as DateTimePayload;
}

describe('CurrentDateTime', () => {
  it('falls back to UTC when constructed without a timezone', async () => {
    const tool = new CurrentDateTime(NOOP_AGENT_TRACING);
    const payload = await callGetCurrentDateTime(tool);

    expect(payload.zoneIsThePersons).toBe(false);
    expect(payload.zone).toBe('UTC');
    expect(payload.utcOffset).toBe('+00:00');
    expect(typeof payload.unixEpochMS).toBe('number');
  });

  it('reports local date/time/zone/offset for a real timezone', async () => {
    const tool = new CurrentDateTime(NOOP_AGENT_TRACING, 'America/Los_Angeles');
    const payload = await callGetCurrentDateTime(tool);

    expect(payload.zoneIsThePersons).toBe(true);
    expect(payload.zone).toBe('America/Los_Angeles');
    expect(payload.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(payload.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('names the local weekday of the local date', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-13T06:00:00Z') });
    try {
      // Friday in UTC, still Thursday evening in Los Angeles.
      const payload = await callGetCurrentDateTime(new CurrentDateTime(NOOP_AGENT_TRACING, 'America/Los_Angeles'));
      expect(payload.date).toBe('2026-11-12');
      expect(payload.weekday).toBe('Thursday');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never shows the UTC day next to the person’s own, when it is already tomorrow in UTC', async () => {
    // 4:01 PM on a Saturday in Los Angeles is one minute into Sunday in UTC.
    jest.useFakeTimers({ now: new Date('2026-11-15T00:01:00Z') });
    try {
      const tool = new CurrentDateTime(NOOP_AGENT_TRACING, 'America/Los_Angeles');
      const text = await answerText(tool);
      expect(await callGetCurrentDateTime(tool)).toEqual({
        date: '2026-11-14',
        weekday: 'Saturday',
        time: '16:01:00',
        zone: 'America/Los_Angeles',
        utcOffset: '-08:00',
        zoneIsThePersons: true,
        unixEpochMS: Date.parse('2026-11-15T00:01:00Z'),
      });
      expect(text).not.toContain('2026-11-15');
      expect(text).not.toContain('Sunday');
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back to UTC for an unrecognized timezone name', async () => {
    const tool = new CurrentDateTime(NOOP_AGENT_TRACING, 'Not/A_Zone');
    const payload = await callGetCurrentDateTime(tool);

    expect(payload.zoneIsThePersons).toBe(false);
    expect(payload.zone).toBe('UTC');
  });
});
