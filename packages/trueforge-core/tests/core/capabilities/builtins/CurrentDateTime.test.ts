import {
  CurrentDateTime,
  GET_CURRENT_DATETIME_TOOL_NAME,
} from '../../../../src/core/capabilities/builtins/CurrentDateTime';
import { isCallToolResponseResult } from '../../../../src/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';

interface DateTimePayload {
  local: { date: string; time: string; zone: string; utcOffset: string; isFallback: boolean };
  utc: { iso: string; unixEpochMS: number };
}

async function callGetCurrentDateTime(tool: CurrentDateTime): Promise<DateTimePayload> {
  const response = await tool.callTool({ name: GET_CURRENT_DATETIME_TOOL_NAME, arguments: {} });
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a resolved call_tool response');
  }
  const first = response.result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  return JSON.parse(first.text) as DateTimePayload;
}

describe('CurrentDateTime', () => {
  it('falls back to UTC when constructed without a timezone', async () => {
    const tool = new CurrentDateTime(NOOP_AGENT_TRACING);
    const payload = await callGetCurrentDateTime(tool);

    expect(payload.local.isFallback).toBe(true);
    expect(payload.local.zone).toBe('UTC');
    expect(payload.utc.iso.endsWith('Z')).toBe(true);
    expect(typeof payload.utc.unixEpochMS).toBe('number');
  });

  it('reports local date/time/zone/offset for a real timezone', async () => {
    const tool = new CurrentDateTime(NOOP_AGENT_TRACING, 'America/Los_Angeles');
    const payload = await callGetCurrentDateTime(tool);

    expect(payload.local.isFallback).toBe(false);
    expect(payload.local.zone).toBe('America/Los_Angeles');
    expect(payload.local.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(payload.local.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.local.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('falls back to UTC for an unrecognized timezone name', async () => {
    const tool = new CurrentDateTime(NOOP_AGENT_TRACING, 'Not/A_Zone');
    const payload = await callGetCurrentDateTime(tool);

    expect(payload.local.isFallback).toBe(true);
    expect(payload.local.zone).toBe('UTC');
  });
});
