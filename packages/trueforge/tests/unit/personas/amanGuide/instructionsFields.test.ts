import { AMAN_GUIDE_INSTRUCTIONS } from '../../../../src/personas/amanGuide/install';
import { HelpConnectorStateSchema, HelpStateSchema } from '../../../../src/schemas/help';

/** Every `snake_case` name the guide's instructions point at. */
function fieldsNamed(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)*)`/g)].flatMap(match =>
    match[1] === undefined ? [] : [match[1]],
  );
}

const REPORTED_FIELDS = new Set([
  ...Object.keys(HelpStateSchema.shape),
  ...Object.keys(HelpConnectorStateSchema.shape),
]);

describe('the guide instructions', () => {
  it('name only help check fields that exist', () => {
    const named = fieldsNamed(AMAN_GUIDE_INSTRUCTIONS);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter(field => !REPORTED_FIELDS.has(field))).toEqual([]);
  });

  it('a field the check does not report would be caught', () => {
    expect(fieldsNamed('Read its `last_backup_at`.').filter(field => !REPORTED_FIELDS.has(field))).toEqual([
      'last_backup_at',
    ]);
  });
});
