import type { Persona } from '../../../src/personas/persona';
import {
  isUnambiguousDirectPersonaInvocation,
  type DirectPersonaInvocationCheck,
} from '../../../src/runtime/personaIntent';

function persona(input: { id: string; displayName: string }): Persona {
  return {
    tenant_id: 'default',
    id: input.id,
    created_by: 'user-1',
    display_name: input.displayName,
    aliases: [],
    instructions: `Answer as ${input.displayName}.`,
    model_name: 'local/model',
    created_at: '2026-09-02T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
    updated_by: 'user-1',
  };
}

const ZARA = persona({ id: 'zara-id', displayName: 'Zara' });
const MILO = persona({ id: 'milo-id', displayName: 'Milo' });
const ZARA_QUINN = persona({ id: 'zara-quinn-id', displayName: 'Zara Quinn' });

type Target = { kind: 'persona'; persona: Persona } | { kind: 'default' };
const ZARA_TARGET: Target = { kind: 'persona', persona: ZARA };
const DEFAULT_TARGET: Target = { kind: 'default' };

function check(message: string, target: Target, personas: Persona[] = [ZARA, MILO]): DirectPersonaInvocationCheck {
  return isUnambiguousDirectPersonaInvocation({
    message,
    target,
    defaultAssistantName: 'Aman',
    personas,
  });
}

describe('isUnambiguousDirectPersonaInvocation', () => {
  it.each([
    ['Zara, answer.'],
    ['ask Zara what she thinks'],
    ['switch to Zara'],
    ['switch back to Zara'],
    ['speak with Zara'],
    ['please switch to Zara'],
    ['can you switch to Zara'],
    ['switch to my Zara'],
    ['switch to the Zara'],
  ])('accepts an unambiguous invocation: %s', message => {
    expect(check(message, ZARA_TARGET)).toEqual({ ok: true });
  });

  it.each([['switch to default'], ['switch to Default'], ['switch back to Aman'], ['please switch to Aman']])(
    'accepts an unambiguous default-assistant invocation: %s',
    message => {
      expect(check(message, DEFAULT_TARGET)).toEqual({ ok: true });
    },
  );

  it('reports ambiguity with the candidate identity keys in mention order', () => {
    expect(check('switch to Zara or Zara Quinn', ZARA_TARGET, [ZARA, ZARA_QUINN])).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidateKeys: ['persona:zara-id', 'persona:zara-quinn-id'],
    });
    expect(check('switch to Milo or Zara', { kind: 'persona', persona: MILO })).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidateKeys: ['persona:milo-id', 'persona:zara-id'],
    });
    expect(check('switch to Zara or default', ZARA_TARGET)).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidateKeys: ['persona:zara-id', 'default'],
    });
  });

  it.each([["Don't switch to Zara."], ['Zara, do not answer this.']])('fails closed on negation: %s', message => {
    expect(check(message, ZARA_TARGET)).toEqual({ ok: false, reason: 'negated' });
  });

  it('fails closed on quoted invocations', () => {
    expect(check('The transcript says "switch to Zara"', ZARA_TARGET)).toEqual({
      ok: false,
      reason: 'quoted',
    });
    expect(check('````\nZara, answer.\n````', ZARA_TARGET, [ZARA])).toEqual({
      ok: false,
      reason: 'quoted',
    });
  });

  it.each([['Zara is a clothing brand.'], ['Zara, answer. Milo, answer.'], ['Zara, answer. Actually, never mind.']])(
    'fails closed without a notice case on: %s',
    message => {
      const result = check(message, ZARA_TARGET);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toBe('ambiguous');
        expect(result.candidateKeys).toBeUndefined();
      }
    },
  );

  it('keeps compatibility-expanded identity offsets aligned with source text', () => {
    const ffi = persona({ id: 'ffi-id', displayName: 'ffi' });
    expect(check('ﬃ,cancel.', { kind: 'persona', persona: ffi }, [ffi])).toEqual({ ok: false, reason: 'no-match' });
  });
});
