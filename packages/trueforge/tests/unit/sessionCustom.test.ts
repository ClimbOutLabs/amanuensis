import { SessionStoreInvariantError } from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import { parseTurnCustom } from '../../src/db/sessionCustom';

describe('parseTurnCustom', () => {
  it('round-trips the complete persisted persona snapshot', () => {
    const stored = {
      persona: {
        persona_id: 'persona-zara',
        persona_name: 'Zara',
        model_name: 'local/psychology',
        source: 'sticky',
      },
      manual_persona_activation_id: 'activation-17',
    };

    expect(parseTurnCustom(stored)).toEqual(stored);
    expect(parseTurnCustom(null)).toBeNull();
  });

  it('round-trips the library near-miss carry flag', () => {
    expect(parseTurnCustom({ library_near_miss: true })).toEqual({ library_near_miss: true });
    expect(parseTurnCustom({ library_near_miss: null })).toEqual({ library_near_miss: null });
    expect(parseTurnCustom({})).toEqual({});
  });

  it.each([
    [17],
    ['persisted metadata'],
    [[]],
    [new Date()],
    [{ unexpected: true }],
    [{ manual_persona_activation_id: 17 }],
    [{ manual_persona_activation_id: '' }],
    [{ manual_persona_activation_id: '   ' }],
    [{ persona: 'Zara' }],
    [{ persona: [] }],
    [{ persona: { persona_id: '', persona_name: 'Zara', model_name: 'm', source: 'sticky' } }],
    [{ persona: { persona_id: 'p', persona_name: ' ', model_name: 'm', source: 'sticky' } }],
    [{ persona: { persona_id: 'p', persona_name: 'Zara', model_name: '', source: 'sticky' } }],
    [{ persona: { persona_id: 'p', persona_name: 'Zara', model_name: 'm', source: 'sticky', nested: {} } }],
    [{ persona: { persona_id: 'p', persona_name: 'Zara', model_name: 'm', source: 'manual' } }],
    [{ library_near_miss: 'yes' }],
    [{ library_near_miss: 1 }],
    [
      {
        persona: {
          persona_id: 'p',
          persona_name: 'Zara',
          model_name: 'm',
          source: 'sticky',
          unexpected: true,
        },
      },
    ],
  ])('fails closed on malformed persisted metadata: %p', stored => {
    expect(() => parseTurnCustom(stored)).toThrow(SessionStoreInvariantError);
  });
});
