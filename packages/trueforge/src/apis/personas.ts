import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import type { ResolveRequestContext } from '../auth/identity';
import type { IModelProviderStore } from '../db/modelProviderStore';
import { PersonaNameConflictError, type IPersonaStore } from '../db/personaStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { buildPersonaContext, type Persona, type PersonaActivation } from '../personas/persona';
import { personaKnowledgeLocation } from '../personaKnowledge/knowledgePaths';
import { closePersonaKnowledgeRepository } from '../personaKnowledge/sqliteKnowledgeRepository';
import {
  createPersonaRoute,
  deletePersonaRoute,
  getPersonaContextRoute,
  getSessionPersonaRoute,
  listPersonasRoute,
  listSessionPersonaActivationsRoute,
  setSessionPersonaRoute,
  updatePersonaRoute,
} from '../routes/personaRoutes';
import { assertPersonaModelAvailable } from '../runtime/turnPersona';
import type { PersonaActivationWire, PersonaWire } from '../schemas/persona';
import { checkSessionAccess, FORBIDDEN_SESSION_ACCESS, TENANT_ID } from './sessions';

/** Newest-first activation window served by the log endpoint. */
const ACTIVATION_PAGE_SIZE = 100;

function toWirePersona(persona: Persona): PersonaWire {
  return {
    id: persona.id,
    display_name: persona.display_name,
    aliases: persona.aliases,
    instructions: persona.instructions,
    model_name: persona.model_name,
    created_by: persona.created_by,
    created_at: persona.created_at,
    updated_at: persona.updated_at,
    updated_by: persona.updated_by,
  };
}

function toWireActivation(activation: PersonaActivation): PersonaActivationWire {
  return {
    id: activation.id,
    session_id: activation.session_id,
    turn_id: activation.turn_id,
    persona_id: activation.persona_id,
    persona_name: activation.persona_name,
    model_name: activation.model_name,
    source: activation.source,
    created_at: activation.created_at,
  };
}

export interface PersonasRouterDeps {
  personaStore: IPersonaStore;
  resolveModelProviderStore: (c: Context) => IModelProviderStore;
  resolveRequestContext: ResolveRequestContext;
  /**
   * When set, deleting a persona also removes its knowledge library database
   * and pending upload blobs. Optional so existing callers keep compiling.
   */
  knowledgeDir?: string;
}

/** Persona CRUD (mounted at /api/v1/personas). */
export function createPersonasRouter(deps: PersonasRouterDeps) {
  const listHandler: RouteHandler<typeof listPersonasRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const personas = await deps.personaStore.listPersonas({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
    });
    return c.json({ data: personas.map(toWirePersona) }, 200);
  };

  const createHandler: RouteHandler<typeof createPersonaRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { persona } = c.req.valid('json');
    // A persona whose model does not exist cannot answer, so it is refused at
    // write time rather than accepted and failed at the first invocation.
    await assertPersonaModelAvailable({
      displayName: persona.display_name,
      modelName: persona.model_name,
      tenant_id: TENANT_ID,
      modelProviderStore: deps.resolveModelProviderStore(c),
    });
    try {
      const created = await deps.personaStore.createPersona({
        tenant_id: TENANT_ID,
        created_by: requestContext.subject.id,
        updated_by: requestContext.subject.id,
        id: ulid().toLowerCase(),
        ...persona,
      });
      return c.json({ data: toWirePersona(created) }, 201);
    } catch (error) {
      if (error instanceof PersonaNameConflictError) {
        return c.json({ error: { message: error.message, type: 'conflict' } }, 409);
      }
      throw error;
    }
  };

  const updateHandler: RouteHandler<typeof updatePersonaRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { persona_id: personaId } = c.req.valid('param');
    const { persona } = c.req.valid('json');
    const existing = await deps.personaStore.getPersona({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
      id: personaId,
    });
    if (existing === undefined) {
      return c.json({ error: { message: `Persona not found: ${personaId}` } }, 404);
    }
    await assertPersonaModelAvailable({
      displayName: persona.display_name,
      modelName: persona.model_name,
      tenant_id: TENANT_ID,
      modelProviderStore: deps.resolveModelProviderStore(c),
    });
    try {
      const updated = await deps.personaStore.updatePersona({
        tenant_id: TENANT_ID,
        created_by: requestContext.subject.id,
        updated_by: requestContext.subject.id,
        id: personaId,
        ...persona,
      });
      if (updated === undefined) {
        return c.json({ error: { message: `Persona not found: ${personaId}` } }, 404);
      }
      return c.json({ data: toWirePersona(updated) }, 200);
    } catch (error) {
      if (error instanceof PersonaNameConflictError) {
        return c.json({ error: { message: error.message, type: 'conflict' } }, 409);
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deletePersonaRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { persona_id: personaId } = c.req.valid('param');
    await deps.personaStore.deletePersona({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
      id: personaId,
    });
    // A deleted persona's library must not linger: drop its database (plus the
    // SQLite -wal/-shm sidecars, which would otherwise resurrect content),
    // and any blobs waiting for the background indexer. Best-effort — the
    // persona row is already gone, so a failed cleanup only wastes disk,
    // never leaks.
    if (deps.knowledgeDir !== undefined) {
      const { dbPath } = personaKnowledgeLocation({
        knowledgeDir: deps.knowledgeDir,
        tenantId: TENANT_ID,
        personaId,
      });
      // Evict the process-wide cached handle first: otherwise it would keep
      // writing to the unlinked file after the rm below.
      closePersonaKnowledgeRepository({ dbPath });
      for (const sidecar of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        await rm(sidecar, { force: true }).catch(() => undefined);
      }
      await rm(path.resolve(deps.knowledgeDir, TENANT_ID, `${personaId}.blobs`), {
        force: true,
        recursive: true,
      }).catch(() => undefined);
    }
    return c.json({}, 200);
  };

  const contextHandler: RouteHandler<typeof getPersonaContextRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { persona_id: personaId } = c.req.valid('param');
    const persona = await deps.personaStore.getPersona({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
      id: personaId,
    });
    if (persona === undefined) {
      return c.json({ error: { message: `Persona not found: ${personaId}` } }, 404);
    }
    return c.json({ data: buildPersonaContext(persona) }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listPersonasRoute, listHandler);
  router.openapi(createPersonaRoute, createHandler);
  router.openapi(updatePersonaRoute, updateHandler);
  router.openapi(deletePersonaRoute, deleteHandler);
  router.openapi(getPersonaContextRoute, contextHandler);
  return router;
}

export interface SessionPersonasRouterDeps {
  personaStore: IPersonaStore;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  resolveRequestContext: ResolveRequestContext;
}

/** Per-chat persona state (mounted at /api/v1/sessions). */
export function createSessionPersonasRouter(deps: SessionPersonasRouterDeps) {
  const getHandler: RouteHandler<typeof getSessionPersonaRoute> = async c => {
    c.header('Cache-Control', 'private, no-store');
    const { session_id: sessionId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessionStore.getSession({ tenant_id: TENANT_ID, session_id: sessionId });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (!checkSessionAccess({ userRef: requestContext.subject.id, createdBy: session.created_by_subject.subject_id })) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const active = await deps.personaStore.getSessionPersona({ tenant_id: TENANT_ID, session_id: sessionId });
    if (active === undefined) {
      return c.json({ data: null }, 200);
    }
    // The log outlives the personas it names, so its newest row can still name
    // one the user has since deleted. The turn resolver answers as the default
    // assistant in that case, and the indicator has to say the same thing
    // rather than name a persona no turn will ever route to. The lookup is
    // scoped to this tenant and this owner, so another owner's persona of the
    // same id cannot keep it alive.
    if (active.persona_id !== null) {
      const stillConfigured = await deps.personaStore.getPersona({
        tenant_id: TENANT_ID,
        created_by: requestContext.subject.id,
        id: active.persona_id,
      });
      if (stillConfigured === undefined) {
        return c.json({ data: null }, 200);
      }
    }
    return c.json({ data: toWireActivation(active) }, 200);
  };

  const setHandler: RouteHandler<typeof setSessionPersonaRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const { persona_id: personaId } = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessionStore.getSession({ tenant_id: TENANT_ID, session_id: sessionId });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (!checkSessionAccess({ userRef: requestContext.subject.id, createdBy: session.created_by_subject.subject_id })) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const persona =
      personaId === null
        ? undefined
        : await deps.personaStore.getPersona({
            tenant_id: TENANT_ID,
            created_by: requestContext.subject.id,
            id: personaId,
          });
    if (personaId !== null && persona === undefined) {
      return c.json({ error: { message: `Persona not found: ${personaId}` } }, 404);
    }
    const recorded = await deps.personaStore.recordPersonaActivation({
      tenant_id: TENANT_ID,
      id: ulid().toLowerCase(),
      session_id: sessionId,
      turn_id: null,
      persona_id: persona?.id ?? null,
      persona_name: persona?.display_name ?? null,
      model_name: persona?.model_name ?? null,
      source: persona === undefined ? 'default' : 'explicit',
    });
    return c.json({ data: toWireActivation(recorded) }, 200);
  };

  const listActivationsHandler: RouteHandler<typeof listSessionPersonaActivationsRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const session = await deps.sessionStore.getSession({ tenant_id: TENANT_ID, session_id: sessionId });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !checkSessionAccess({
        userRef: deps.resolveRequestContext(c).subject.id,
        createdBy: session.created_by_subject.subject_id,
      })
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const activations = await deps.personaStore.listSessionPersonaActivations({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      limit: ACTIVATION_PAGE_SIZE,
    });
    return c.json({ data: activations.map(toWireActivation) }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getSessionPersonaRoute, getHandler);
  router.openapi(setSessionPersonaRoute, setHandler);
  router.openapi(listSessionPersonaActivationsRoute, listActivationsHandler);
  return router;
}
