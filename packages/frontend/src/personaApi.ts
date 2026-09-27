import type {
  NewPersonaKnowledgeDocument,
  Persona,
  PersonaApi,
  PersonaDraft,
  PersonaKnowledgeDocument,
  PersonaKnowledgeEmbeddingModel,
  SessionPersona,
} from '@truefoundry/trueforge-ui';

const PERSONAS_URL = '/api/v1/personas';

interface PersonaResponse {
  data: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function parsePersona(data: unknown): Persona {
  if (typeof data !== 'object' || data === null) {
    throw new Error('The persona response was invalid.');
  }
  const persona: Record<string, unknown> = { ...data };
  if (
    typeof persona.id !== 'string' ||
    typeof persona.display_name !== 'string' ||
    typeof persona.instructions !== 'string' ||
    typeof persona.model_name !== 'string' ||
    !isStringArray(persona.aliases)
  ) {
    throw new Error('The persona response was invalid.');
  }
  return {
    id: persona.id,
    display_name: persona.display_name,
    aliases: persona.aliases,
    instructions: persona.instructions,
    model_name: persona.model_name,
  };
}

function parseSessionPersona(data: unknown): SessionPersona | null {
  if (data === null) {
    return null;
  }
  if (typeof data !== 'object') {
    throw new Error('The session persona response was invalid.');
  }
  const activation: Record<string, unknown> = { ...data };
  const { persona_id: personaId, persona_name: name, model_name: model, source, turn_id: turnId } = activation;
  if (
    (personaId !== null && typeof personaId !== 'string') ||
    (name !== null && typeof name !== 'string') ||
    (model !== null && typeof model !== 'string') ||
    (turnId !== null && typeof turnId !== 'string') ||
    (source !== 'invocation' && source !== 'sticky' && source !== 'explicit' && source !== 'default')
  ) {
    throw new Error('The session persona response was invalid.');
  }
  return { persona_id: personaId, persona_name: name, model_name: model, source, turn_id: turnId };
}

function parseKnowledgeDocument(data: unknown): PersonaKnowledgeDocument {
  if (typeof data !== 'object' || data === null) {
    throw new Error('The knowledge response was invalid.');
  }
  const document: Record<string, unknown> = { ...data };
  if (
    typeof document.id !== 'string' ||
    typeof document.title !== 'string' ||
    typeof document.title_explicit !== 'boolean' ||
    (document.source_kind !== 'upload' && document.source_kind !== 'url' && document.source_kind !== 'text') ||
    typeof document.source_label !== 'string' ||
    (document.source_url !== null && typeof document.source_url !== 'string') ||
    (document.status !== 'pending' &&
      document.status !== 'parsing' &&
      document.status !== 'indexing' &&
      document.status !== 'ready' &&
      document.status !== 'failed') ||
    (document.status_message !== null && typeof document.status_message !== 'string') ||
    typeof document.chunk_count !== 'number' ||
    typeof document.created_at !== 'string' ||
    typeof document.updated_at !== 'string'
  ) {
    throw new Error('The knowledge response was invalid.');
  }
  return {
    id: document.id,
    title: document.title,
    title_explicit: document.title_explicit,
    source_kind: document.source_kind,
    source_label: document.source_label,
    source_url: document.source_url,
    status: document.status,
    status_message: document.status_message,
    chunk_count: document.chunk_count,
    created_at: document.created_at,
    updated_at: document.updated_at,
  };
}

function parseEmbeddingModel(data: unknown): PersonaKnowledgeEmbeddingModel {
  if (typeof data !== 'object' || data === null) {
    throw new Error('The knowledge response was invalid.');
  }
  const model: Record<string, unknown> = { ...data };
  if (
    (model.phase !== 'idle' &&
      model.phase !== 'loading' &&
      model.phase !== 'downloading' &&
      model.phase !== 'ready' &&
      model.phase !== 'unavailable') ||
    typeof model.message !== 'string'
  ) {
    throw new Error('The knowledge response was invalid.');
  }
  return { phase: model.phase, message: model.message };
}

async function readError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string }; message?: string } | null;
  return new Error(body?.error?.message ?? body?.message ?? `Request failed (${String(response.status)}).`);
}

async function readData(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw await readError(response);
  }
  const body = (await response.json()) as PersonaResponse;
  return body.data;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function createPersonaApi(fetcher: typeof fetch): PersonaApi {
  const sessionPersonaUrl = (sessionId: string) => `/api/v1/sessions/${encodeURIComponent(sessionId)}/persona`;

  return {
    async listPersonas() {
      const data = await readData(await fetcher(PERSONAS_URL));
      if (!Array.isArray(data)) {
        throw new Error('The persona response was invalid.');
      }
      return data.map(parsePersona);
    },
    async createPersona(draft: PersonaDraft) {
      return parsePersona(await readData(await fetcher(PERSONAS_URL, jsonInit('POST', { persona: draft }))));
    },
    async updatePersona(id: string, draft: PersonaDraft) {
      const url = `${PERSONAS_URL}/${encodeURIComponent(id)}`;
      return parsePersona(await readData(await fetcher(url, jsonInit('PUT', { persona: draft }))));
    },
    async deletePersona(id: string) {
      const response = await fetcher(`${PERSONAS_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) {
        throw await readError(response);
      }
    },
    async getSessionPersona(sessionId: string) {
      return parseSessionPersona(await readData(await fetcher(sessionPersonaUrl(sessionId), { cache: 'no-store' })));
    },
    async setSessionPersona(sessionId: string, personaId: string | null) {
      const response = await fetcher(sessionPersonaUrl(sessionId), jsonInit('PUT', { persona_id: personaId }));
      return parseSessionPersona(await readData(response));
    },
    async listPersonaKnowledge(personaId: string) {
      const data = await readData(
        await fetcher(`${PERSONAS_URL}/${encodeURIComponent(personaId)}/knowledge`),
      );
      if (!Array.isArray(data)) {
        throw new Error('The knowledge response was invalid.');
      }
      return data.map(parseKnowledgeDocument);
    },
    async createPersonaKnowledge(personaId: string, input: NewPersonaKnowledgeDocument) {
      const url = `${PERSONAS_URL}/${encodeURIComponent(personaId)}/knowledge`;
      return parseKnowledgeDocument(await readData(await fetcher(url, jsonInit('POST', input))));
    },
    async deletePersonaKnowledge(personaId: string, documentId: string) {
      const url = `${PERSONAS_URL}/${encodeURIComponent(personaId)}/knowledge/${encodeURIComponent(documentId)}`;
      const response = await fetcher(url, { method: 'DELETE' });
      if (!response.ok) {
        throw await readError(response);
      }
    },
    async getPersonaKnowledgeEmbeddingModel(personaId: string) {
      const url = `${PERSONAS_URL}/${encodeURIComponent(personaId)}/knowledge/embedding-model`;
      return parseEmbeddingModel(await readData(await fetcher(url)));
    },
  };
}
