import { DeliverySchema } from '../../../src/schemas/deliveries';

const BASE = {
  id: 'd1',
  level: 'nudge' as const,
  text: 'Something happened.',
  reason: 'Because it matters.',
  created_at: '2026-11-07T15:00:00.000Z',
  seen_at: null,
  attempts: [],
};

describe('DeliverySchema kinds', () => {
  it('reads a brief delivery with its chat link', () => {
    const parsed = DeliverySchema.parse({ ...BASE, kind: 'brief', link: { type: 'chat', session_id: 's1' } });
    expect(parsed.kind).toBe('brief');
    expect(parsed.link).toEqual({ type: 'chat', session_id: 's1' });
  });

  it('refuses a brief delivery without a chat link', () => {
    expect(DeliverySchema.safeParse({ ...BASE, kind: 'brief', link: null }).success).toBe(false);
  });

  it('no longer reads the note and nudge kinds, which nothing could create', () => {
    expect(DeliverySchema.safeParse({ ...BASE, kind: 'note', link: null }).success).toBe(false);
    expect(DeliverySchema.safeParse({ ...BASE, kind: 'nudge', link: null }).success).toBe(false);
  });
});
