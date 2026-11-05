import { CreateSpaceRequestSchema, SpaceContentSchema, SpaceSchema } from '../../../src/schemas/space';

const BASE_SPACE = {
  name: 'Spain houses',
  purpose: 'Track candidate houses in Spain.',
  status: 'active' as const,
  body: 'Plain notes.',
};

describe('SpaceContentSchema format', () => {
  it('defaults format to markdown when omitted', () => {
    const parsed = SpaceContentSchema.parse(BASE_SPACE);
    expect(parsed.format).toBe('markdown');
  });

  it('accepts an explicit html format', () => {
    const parsed = SpaceContentSchema.parse({ ...BASE_SPACE, format: 'html' });
    expect(parsed.format).toBe('html');
  });

  it('rejects a format outside markdown/html', () => {
    expect(() => SpaceContentSchema.parse({ ...BASE_SPACE, format: 'rich-text' })).toThrow();
  });

  it('round-trips format through CreateSpaceRequestSchema', () => {
    const parsed = CreateSpaceRequestSchema.parse({
      space: { ...BASE_SPACE, format: 'html' },
      expected_aggregate_revision: 0,
    });
    expect(parsed.space.format).toBe('html');
  });

  it('round-trips format through SpaceSchema (the full wire record)', () => {
    const parsed = SpaceSchema.parse({
      id: 's-1',
      ...BASE_SPACE,
      format: 'html',
      folder_id: null,
      revision: 1,
      created_at: '2026-09-13T00:00:00.000Z',
      updated_at: '2026-09-13T00:00:00.000Z',
    });
    expect(parsed.format).toBe('html');
  });

  it('carries the folder on the wire record but never in the revisioned content', () => {
    const wire = {
      id: 's-1',
      ...BASE_SPACE,
      folder_id: 'folder-1',
      revision: 1,
      created_at: '2026-09-13T00:00:00.000Z',
      updated_at: '2026-09-13T00:00:00.000Z',
    };

    expect(SpaceSchema.parse(wire).folder_id).toBe('folder-1');
    expect(SpaceContentSchema.safeParse({ ...BASE_SPACE, folder_id: 'folder-1' }).success).toBe(false);
  });
});
