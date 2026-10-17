import type { ISentinelAuditStore } from '../../src/db/sentinelAuditStore';

export function runSentinelAuditStoreContractSuite(makeStore: () => ISentinelAuditStore): void {
  describe('listByCreator', () => {
    const entry = (input: {
      created_by: string;
      conversation_id: string;
      description: string;
      tenant_id?: string;
    }) => ({
      tenant_id: input.tenant_id ?? 't1',
      created_by: input.created_by,
      conversation_id: input.conversation_id,
      tier: 2 as const,
      tool_name: 'write',
      description: input.description,
      outcome: 'ran' as const,
      auto_deny_reason: null,
    });

    it("returns one person's rows oldest first across chats, including a chat that no longer exists", async () => {
      const store = makeStore();
      await store.record(entry({ created_by: 'u1', conversation_id: 'gone', description: 'first' }));
      await store.record(entry({ created_by: 'u2', conversation_id: 's1', description: 'other person' }));
      await store.record(entry({ created_by: 'u1', conversation_id: 's1', description: 'second', tenant_id: 't2' }));
      await store.record(entry({ created_by: 'u1', conversation_id: 's1', description: 'third' }));

      const rows = await store.listByCreator({ tenant_id: 't1', created_by: 'u1', limit: 50, offset: 0 });
      expect(rows.map(row => row.description)).toEqual(['first', 'third']);
    });

    it('pages without repeating or skipping a row', async () => {
      const store = makeStore();
      for (let i = 0; i < 5; i += 1) {
        await store.record(entry({ created_by: 'u1', conversation_id: 's1', description: `row ${String(i)}` }));
      }
      const seen: string[] = [];
      for (let offset = 0; offset < 5; offset += 2) {
        const page = await store.listByCreator({ tenant_id: 't1', created_by: 'u1', limit: 2, offset });
        seen.push(...page.map(row => row.id));
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });
  });
}
