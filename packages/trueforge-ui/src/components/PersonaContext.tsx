'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';

import { isServerVoiceId, type ServerVoiceId } from '../utils/speechReplyPreferences.js';

/** Identity, role, and model binding for one configured persona. */
export type Persona = {
  id: string;
  display_name: string;
  aliases: string[];
  instructions: string;
  model_name: string;
  /** Voice that reads this persona's replies aloud; null uses the person's own voice choice. */
  voice: string | null;
};

export type PersonaDraft = Omit<Persona, 'id'>;

/** How the persona answering a chat was decided; mirrors the server's activation log. */
export type PersonaActivationSource = 'invocation' | 'sticky' | 'explicit' | 'default';

/** The chat's most recent persona decision. `persona_id: null` = the default assistant. */
export type SessionPersona = {
  persona_id: string | null;
  persona_name: string | null;
  model_name: string | null;
  source: PersonaActivationSource;
  turn_id: string | null;
};

/** Which persona answered one turn. `persona_id: null` = the default assistant. */
export type TurnPersona = {
  persona_id: string | null;
};

export type PersonaApi = {
  listPersonas: () => Promise<Persona[]>;
  createPersona: (draft: PersonaDraft) => Promise<Persona>;
  updatePersona: (id: string, draft: PersonaDraft) => Promise<Persona>;
  deletePersona: (id: string) => Promise<void>;
  getSessionPersona: (sessionId: string) => Promise<SessionPersona | null>;
  setSessionPersona: (sessionId: string, personaId: string | null) => Promise<SessionPersona | null>;
  getTurnPersona: (input: { sessionId: string; turnId: string }) => Promise<TurnPersona>;
  listPersonaKnowledge: (personaId: string) => Promise<PersonaKnowledgeDocument[]>;
  createPersonaKnowledge: (personaId: string, input: NewPersonaKnowledgeDocument) => Promise<PersonaKnowledgeDocument>;
  deletePersonaKnowledge: (personaId: string, documentId: string) => Promise<void>;
  getPersonaKnowledgeEmbeddingModel: (personaId: string) => Promise<PersonaKnowledgeEmbeddingModel>;
};

/** Indexing state of one knowledge document; shown verbatim in Settings. */
export type PersonaKnowledgeDocumentStatus = 'pending' | 'parsing' | 'indexing' | 'ready' | 'failed';

/** How a knowledge document entered the library. */
export type PersonaKnowledgeSourceKind = 'upload' | 'url' | 'text';

/** One document in a persona's knowledge library. */
export type PersonaKnowledgeDocument = {
  id: string;
  title: string;
  title_explicit: boolean;
  source_kind: PersonaKnowledgeSourceKind;
  source_label: string;
  source_url: string | null;
  status: PersonaKnowledgeDocumentStatus;
  status_message: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
};

export type NewPersonaKnowledgeUpload = {
  kind: 'upload';
  filename: string;
  content_base64: string;
  title?: string;
};

export type NewPersonaKnowledgeUrl = {
  kind: 'url';
  url: string;
  title?: string;
};

export type NewPersonaKnowledgeText = {
  kind: 'text';
  title: string;
  text: string;
};

export type NewPersonaKnowledgeDocument = NewPersonaKnowledgeUpload | NewPersonaKnowledgeUrl | NewPersonaKnowledgeText;

/** One-time search model state, described in plain English for the UI. */
export type PersonaKnowledgeEmbeddingModel = {
  phase: 'idle' | 'loading' | 'downloading' | 'ready' | 'unavailable';
  message: string;
};

export const EMPTY_PERSONA_DRAFT: PersonaDraft = {
  display_name: '',
  aliases: [],
  instructions: '',
  model_name: '',
  voice: null,
};

type PersonaContextValue = {
  personas: Persona[];
  loading: boolean;
  loadError: string | null;
  createPersona: (draft: PersonaDraft) => Promise<Persona>;
  updatePersona: (id: string, draft: PersonaDraft) => Promise<Persona>;
  deletePersona: (id: string) => Promise<void>;
  getSessionPersona: (sessionId: string) => Promise<SessionPersona | null>;
  setSessionPersona: (sessionId: string, personaId: string | null) => Promise<SessionPersona | null>;
  /**
   * The voice picked for the persona that answered this turn, or undefined when that persona has none
   * (or the default assistant answered), so the person's own voice choice reads it.
   */
  voiceForTurn: (input: { sessionId: string; turnId: string }) => Promise<ServerVoiceId | undefined>;
  listPersonaKnowledge: (personaId: string) => Promise<PersonaKnowledgeDocument[]>;
  createPersonaKnowledge: (personaId: string, input: NewPersonaKnowledgeDocument) => Promise<PersonaKnowledgeDocument>;
  deletePersonaKnowledge: (personaId: string, documentId: string) => Promise<void>;
  getPersonaKnowledgeEmbeddingModel: (personaId: string) => Promise<PersonaKnowledgeEmbeddingModel>;
  reload: () => Promise<void>;
};

const PersonaContext = createContext<PersonaContextValue | null>(null);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const PersonaProvider: FC<{ api: PersonaApi; children: ReactNode }> = ({ api, children }) => {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setPersonas(await api.listPersonas());
    } catch (error) {
      setLoadError(errorMessage(error, 'Could not load personas.'));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createPersona = useCallback(
    async (draft: PersonaDraft) => {
      const created = await api.createPersona(draft);
      await reload();
      return created;
    },
    [api, reload],
  );

  const updatePersona = useCallback(
    async (id: string, draft: PersonaDraft) => {
      const updated = await api.updatePersona(id, draft);
      await reload();
      return updated;
    },
    [api, reload],
  );

  const deletePersona = useCallback(
    async (id: string) => {
      await api.deletePersona(id);
      await reload();
    },
    [api, reload],
  );

  const { getSessionPersona, setSessionPersona } = api;

  // Who answered a turn never changes, so each turn is asked about once. The voice is read from the
  // current persona list, so a voice changed in Settings applies to the next reply read aloud.
  const turnPersonaIds = useRef(new Map<string, Promise<string | null>>());
  const personasRef = useRef(personas);
  personasRef.current = personas;
  const voiceForTurn = useCallback(
    async ({ sessionId, turnId }: { sessionId: string; turnId: string }): Promise<ServerVoiceId | undefined> => {
      const cacheKey = `${sessionId}/${turnId}`;
      let personaId = turnPersonaIds.current.get(cacheKey);
      if (personaId === undefined) {
        personaId = api.getTurnPersona({ sessionId, turnId }).then(turn => turn.persona_id);
        turnPersonaIds.current.set(cacheKey, personaId);
        // A failed lookup is not remembered, so the next reply read aloud asks again.
        personaId.catch(() => turnPersonaIds.current.delete(cacheKey));
      }
      const id = await personaId;
      const voice = id === null ? null : (personasRef.current.find(persona => persona.id === id)?.voice ?? null);
      return voice !== null && isServerVoiceId(voice) ? voice : undefined;
    },
    [api],
  );

  const listPersonaKnowledge = useCallback((personaId: string) => api.listPersonaKnowledge(personaId), [api]);
  const createPersonaKnowledge = useCallback(
    (personaId: string, input: NewPersonaKnowledgeDocument) => api.createPersonaKnowledge(personaId, input),
    [api],
  );
  const deletePersonaKnowledge = useCallback(
    (personaId: string, documentId: string) => api.deletePersonaKnowledge(personaId, documentId),
    [api],
  );
  const getPersonaKnowledgeEmbeddingModel = useCallback(
    (personaId: string) => api.getPersonaKnowledgeEmbeddingModel(personaId),
    [api],
  );

  const value = useMemo(
    () => ({
      personas,
      loading,
      loadError,
      createPersona,
      updatePersona,
      deletePersona,
      getSessionPersona,
      setSessionPersona,
      voiceForTurn,
      listPersonaKnowledge,
      createPersonaKnowledge,
      deletePersonaKnowledge,
      getPersonaKnowledgeEmbeddingModel,
      reload,
    }),
    [
      personas,
      loading,
      loadError,
      createPersona,
      updatePersona,
      deletePersona,
      getSessionPersona,
      setSessionPersona,
      voiceForTurn,
      listPersonaKnowledge,
      createPersonaKnowledge,
      deletePersonaKnowledge,
      getPersonaKnowledgeEmbeddingModel,
      reload,
    ],
  );

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
};

export function useOptionalPersonas(): PersonaContextValue | null {
  return useContext(PersonaContext);
}

export function usePersonas(): PersonaContextValue {
  const context = useOptionalPersonas();
  if (context == null) {
    throw new Error('usePersonas must be used within a PersonaProvider.');
  }
  return context;
}
