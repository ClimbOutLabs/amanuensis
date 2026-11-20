// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { PersonaProvider, usePersonas, type Persona, type PersonaApi } from '@/components/PersonaContext.js';
import { personaApiStubs } from '../personaApiStubs.js';

const ZARA: Persona = {
  id: 'p-zara',
  display_name: 'Zara',
  aliases: [],
  instructions: 'Answer plainly.',
  model_name: 'scripted/model',
  voice: 'af_bella',
};

function personaApi(input: {
  personas: () => Persona[];
  answer: (turnId: string) => Promise<{ persona_id: string | null }>;
}): PersonaApi & { lookups: string[] } {
  const lookups: string[] = [];
  const unused = () => Promise.reject(new Error('not used in this test'));
  return {
    ...personaApiStubs,
    lookups,
    listPersonas: () => Promise.resolve(input.personas()),
    createPersona: unused,
    updatePersona: unused,
    deletePersona: unused,
    getSessionPersona: () => Promise.resolve(null),
    setSessionPersona: unused,
    getTurnPersona: ({ turnId }) => {
      lookups.push(turnId);
      return input.answer(turnId);
    },
  };
}

function renderPersonas(api: PersonaApi) {
  const wrapper = ({ children }: { children: ReactNode }) => <PersonaProvider api={api}>{children}</PersonaProvider>;
  return renderHook(() => usePersonas(), { wrapper });
}

describe('voiceForTurn', () => {
  it('asks once who answered a turn, and reads that persona’s voice from the current list', async () => {
    let personas = [ZARA];
    const api = personaApi({ personas: () => personas, answer: async () => ({ persona_id: 'p-zara' }) });
    const { result } = renderPersonas(api);
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.voiceForTurn({ sessionId: 's1', turnId: 't1' })).resolves.toBe('af_bella');

    personas = [{ ...ZARA, voice: 'am_michael' }];
    await result.current.reload();
    await waitFor(() => expect(result.current.personas[0]?.voice).toBe('am_michael'));
    await expect(result.current.voiceForTurn({ sessionId: 's1', turnId: 't1' })).resolves.toBe('am_michael');
    expect(api.lookups).toEqual(['t1']);
  });

  it('has no voice for the main assistant, a persona without one, a deleted persona, or an unknown voice', async () => {
    const personas: Persona[] = [
      { ...ZARA, id: 'p-plain', voice: null },
      { ...ZARA, id: 'p-odd', voice: 'not_a_voice' },
    ];
    const answers: Record<string, string | null> = { main: null, plain: 'p-plain', gone: 'p-gone', odd: 'p-odd' };
    const api = personaApi({
      personas: () => personas,
      answer: async turnId => ({ persona_id: answers[turnId] ?? null }),
    });
    const { result } = renderPersonas(api);
    await waitFor(() => expect(result.current.loading).toBe(false));

    for (const turnId of Object.keys(answers)) {
      await expect(result.current.voiceForTurn({ sessionId: 's1', turnId })).resolves.toBeUndefined();
    }
  });

  it('asks again after a lookup failed', async () => {
    let fail = true;
    const api = personaApi({
      personas: () => [ZARA],
      answer: async () => {
        if (fail) throw new Error('offline');
        return { persona_id: 'p-zara' };
      },
    });
    const { result } = renderPersonas(api);
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.voiceForTurn({ sessionId: 's1', turnId: 't1' })).rejects.toThrow('offline');
    fail = false;
    await expect(result.current.voiceForTurn({ sessionId: 's1', turnId: 't1' })).resolves.toBe('af_bella');
    expect(api.lookups).toEqual(['t1', 't1']);
  });
});
