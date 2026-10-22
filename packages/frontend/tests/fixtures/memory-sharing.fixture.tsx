import { PersonaProvider, TrueForgeUI, type Persona, type PersonaApi } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

/**
 * The real shell with seven invented specialists and a sharing config. Every other API call
 * answers 503, so the shell renders its chrome without a backend.
 */
const SPECIALIST_NAMES = ['Anna', 'Cole', 'Dana', 'Eli', 'Farah', 'Gus', 'Hana'];
const specialists: Persona[] = SPECIALIST_NAMES.map((name, index) => ({
  id: `specialist-${index}`,
  display_name: name,
  aliases: [],
  instructions: '',
  model_name: 'local/qwen3-8b',
}));

const notUsedHere = async (): Promise<never> => {
  throw new Error('Not used in this fixture.');
};

const specialistApi: PersonaApi = {
  listPersonas: async () => specialists,
  createPersona: notUsedHere,
  updatePersona: notUsedHere,
  deletePersona: notUsedHere,
  getSessionPersona: async () => null,
  setSessionPersona: async () => null,
  listPersonaKnowledge: async () => [],
  createPersonaKnowledge: notUsedHere,
  deletePersonaKnowledge: notUsedHere,
  getPersonaKnowledgeEmbeddingModel: notUsedHere,
};

const sharing = { shares: { 'specialist-0': ['persona:Cole'] } };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const fakeFetch: typeof fetch = async input => {
  const url = new URL(String(input instanceof Request ? input.url : input), 'http://127.0.0.1/');
  if (url.pathname === '/api/v1/memory/vault/sharing') return json({ data: sharing });
  if (url.pathname === '/api/v1/memory/vault') return json({ data: [] });
  return new Response('{}', { status: 503 });
};

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') === 'dark' ? 'dark' : 'light';

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <PersonaProvider api={specialistApi}>
    <TrueForgeUI
      layout="dock"
      server={{ type: 'trueforge', baseUrl: 'http://127.0.0.1/', fetch: fakeFetch }}
      theme={{ mode, preset: 'paper' }}
    />
  </PersonaProvider>,
);
