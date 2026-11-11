import type { PersonaApi } from '@/components/PersonaContext.js';

/**
 * Safe defaults for the persona-knowledge and turn-lookup methods of PersonaApi, so tests that
 * do not exercise them compile without implementing them.
 */
export const personaApiStubs: Pick<
  PersonaApi,
  | 'getTurnPersona'
  | 'listPersonaKnowledge'
  | 'createPersonaKnowledge'
  | 'deletePersonaKnowledge'
  | 'getPersonaKnowledgeEmbeddingModel'
> = {
  getTurnPersona: async () => ({ persona_id: null }),
  listPersonaKnowledge: async () => [],
  createPersonaKnowledge: async () => {
    throw new Error('Unexpected knowledge API call');
  },
  deletePersonaKnowledge: async () => {},
  getPersonaKnowledgeEmbeddingModel: async () => ({ phase: 'ready', message: 'Ready.' }),
};
