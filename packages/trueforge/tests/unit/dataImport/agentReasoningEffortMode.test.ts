import { ImportAgentsFileSchema } from '../../../src/dataImport/importSchemas';

/** An agent record as an archive from before reasoning effort had a mode writes it. */
function olderAgentRecord(params: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    id: 'agent-older',
    name: 'older-agent',
    description: 'Written before reasoning effort had a mode.',
    manifest: { model: { name: 'openai/gpt-5.2', ...(params === undefined ? {} : { params }) } },
    external_id: null,
    created_by_subject: { subject_id: 'owner-1', subject_type: 'user', subject_display_name: 'Owner' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function importedModelParams(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const [agent] = ImportAgentsFileSchema.parse([record]);
  return agent?.manifest.model.params;
}

describe('imported agent reasoning effort mode', () => {
  it('imports an older agent with a stored effort as automatic, keeping the effort', () => {
    expect(importedModelParams(olderAgentRecord({ reasoning_effort: 'low' }))).toEqual({
      reasoning_effort: 'low',
      reasoning_effort_mode: 'automatic',
    });
  });

  it('leaves an agent with no params alone, since absent already means automatic', () => {
    expect(importedModelParams(olderAgentRecord(undefined))).toBeUndefined();
  });

  it('keeps a mode the archive already holds', () => {
    expect(importedModelParams(olderAgentRecord({ reasoning_effort: 'high', reasoning_effort_mode: 'fixed' }))).toEqual(
      { reasoning_effort: 'high', reasoning_effort_mode: 'fixed' },
    );
  });
});
