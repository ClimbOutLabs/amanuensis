/**
 * Every tool of a personal instance must get the same permission decision whether the model calls it
 * straight away or reads its guidance with load_bundle first: the same tier and reason,
 * the same card, the same hold or refusal, and the same audit rows. Run online (cards and silent
 * runs) and offline (refusals).
 */
import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import { DEFERRED_TOOLS_SERVER_ID } from '@truefoundry/trueforge-core/core/runtime/DeferredTool';
import type { ToolBundleName } from '@truefoundry/trueforge-core/core/runtime/toolBundleCatalog';
import { TOOL_BUNDLES_SERVER_ID } from '@truefoundry/trueforge-core/core/runtime/ToolBundles';
import { judge, toolTable, type Judged, type Mode, type ToolRow } from './toolJudgingKit';

describe('the same permission decision for every tool, whether or not its guidance was read', () => {
  let table: ToolRow[] = [];

  beforeAll(async () => {
    // No test may reach Google or any other service: every outbound request fails at once, the same way both times.
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in tests.'));
    table = (await toolTable()).filter(
      row => row.server !== DEFERRED_TOOLS_SERVER_ID && row.server !== TOOL_BUNDLES_SERVER_ID,
    );
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('covers every built-in tool family, every bundle and both first-party connectors', () => {
    const servers = new Set(table.map(row => row.server));
    for (const server of [
      'google_calendar',
      'gmail',
      'maps',
      'web-search',
      'sandbox',
      'space',
      'schedules',
      'documents',
      'sub_agents',
      'usage',
      'ask-user-question',
      'current-datetime',
      CALDAV_SERVER_NAME,
      MAIL_CONNECTOR_NAME,
    ]) {
      expect(servers).toContain(server);
    }
    expect(new Set(table.map(row => row.bundle))).toEqual(
      new Set<ToolBundleName | undefined>([
        undefined,
        'google',
        'web',
        'maps',
        'sandbox',
        'spaces',
        'documents',
        'schedules',
        'sub_agents',
        'extras',
      ]),
    );
    expect(table.map(row => row.name)).toEqual(expect.arrayContaining(['summarize_net_worth', 'usage_summary']));
    expect(table.length).toBeGreaterThanOrEqual(55);
  });

  it.each<Mode>(['online', 'offline'])(
    'judges each tool the same both ways while %s',
    async mode => {
      const differences: { tool: string; before: Judged; loaded: Judged }[] = [];
      const judged: Judged[] = [];
      for (const row of table) {
        const before = await judge({ mode, row, loading: 'direct' });
        const loaded = await judge({ mode, row, loading: 'load_bundle' });
        judged.push(before.judged);
        if (JSON.stringify(loaded.judged) !== JSON.stringify(before.judged)) {
          differences.push({ tool: row.name, before: before.judged, loaded: loaded.judged });
        }
        // The tool keeps its own name, and reading guidance is a lookup: never a card, never held.
        expect(loaded.judged.name).toBe(row.name);
        expect(loaded.load?.tier3_card ?? null).toBeNull();
        expect(loaded.load?.is_approval_required).toBe(false);
        if (mode === 'online') {
          // Every tool goes out on the first model call, with or without guidance read.
          expect(before.sentBefore).toContain(row.name);
          expect(loaded.sentBefore).toContain(row.name);
          expect(loaded.sentAtCall).toEqual(loaded.sentBefore);
        }
      }
      expect(differences).toEqual([]);
      // The table holds the cases that matter, so equal decisions are not equal by being empty.
      expect(judged.some(entry => entry.decision.tier === 3 && entry.decision.tier3_card !== null)).toBe(true);
      expect(judged.some(entry => entry.decision.tier === 1)).toBe(true);
      expect(judged.some(entry => entry.audit.length > 0)).toBe(true);
      if (mode === 'offline') {
        expect(judged.some(entry => entry.audit.some(audited => audited.outcome === 'auto_denied'))).toBe(true);
      }
    },
    900_000,
  );
});
