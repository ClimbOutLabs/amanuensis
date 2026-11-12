import { suggestAlwaysImportant } from '../../../../src/runtime/noticing/suggestions';

describe('suggestAlwaysImportant', () => {
  it('suggests addresses named in memories, skipping listed and turned down ones', () => {
    const found = suggestAlwaysImportant({
      memories: [
        'My sister Dana writes from Dana@Example.com, answer her first.',
        'Alex is at alex@example.com',
        'Sam is at sam@example.com',
      ],
      settings: {
        always_important: [{ address: 'alex@example.com', source: 'settings', added_at: '2026-11-01T00:00:00.000Z' }],
        dismissed_suggestions: ['SAM@example.com'],
      },
    });
    expect(found.map(item => item.address)).toEqual(['dana@example.com']);
    expect(found[0]?.memory).toContain('sister Dana');
  });
});
