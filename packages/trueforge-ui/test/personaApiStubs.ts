import type { PersonaApi } from '@/components/PersonaContext.js';

/**
 * Safe defaults for the persona-knowledge methods of PersonaApi, so tests that
 * do not exercise the knowledge library compile without implementing them.
 */
export const personaKnowledgeApiStubs: Pick<
  PersonaApi,
  'listPersonaKnowledge' | 'createPersonaKnowledge' | 'deletePersonaKnowledge' | 'getPersonaKnowledgeEmbeddingModel'
> = {
  listPersonaKnowledge: async () => [],
  createPersonaKnowledge: async () => {
    throw new Error('Unexpected knowledge API call');
  },
  deletePersonaKnowledge: async () => {},
  getPersonaKnowledgeEmbeddingModel: async () => ({ phase: 'ready', message: 'Ready.' }),
};
