import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import { PersonalizationRevisionConflictError, type IPersonalizationStore } from '../db/personalizationStore';
import { buildPersonalizationContext, type PersonalizationProfile } from '../personalization/profile';
import {
  deletePersonalizationProfileRoute,
  getPersonalizationContextRoute,
  getPersonalizationProfileRoute,
  updatePersonalizationProfileRoute,
} from '../routes/personalizationRoutes';
import type { MemoryClient } from '../runtime/memory/memoryClient';
import { deleteLearnedProfileCopy } from '../runtime/profileLearning';
import type { PersonalizationProfileWire, UpdatePersonalizationProfileRequest } from '../schemas/personalization';
import { TENANT_ID } from './sessions';

export interface PersonalizationRouterDeps {
  personalizationStore: IPersonalizationStore;
  resolveRequestContext: ResolveRequestContext;
  /** The memory client for this person. */
  resolveMemoryClient: (input: { tenantId: string }) => MemoryClient;
  logger: Logger;
}

/**
 * Projects the stored record onto the published shape. The record carries `tenant_id`, which is
 * host-internal and absent from `PersonalizationProfileSchema`; returning the record whole would
 * put a field on the wire that the contract does not describe.
 */
function toWireProfile(profile: PersonalizationProfile): PersonalizationProfileWire {
  return {
    created_by: profile.created_by,
    assistant_name: profile.assistant_name,
    assistant_identity: profile.assistant_identity,
    voice_guidance: profile.voice_guidance,
    user_name: profile.user_name,
    address_as: profile.address_as,
    user_profile: profile.user_profile,
    pinned_preferences: profile.pinned_preferences,
    help_areas: profile.help_areas,
    learned_profile: profile.learned_profile,
    learning_enabled: profile.learning_enabled,
    revision: profile.revision,
    digest: profile.digest,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    updated_by: profile.updated_by,
  };
}

export function createPersonalizationRouter(deps: PersonalizationRouterDeps) {
  // Saving or deleting the profile also removes any copy an earlier version kept in memory, so
  // what a person clears in Settings is no longer used anywhere. A failure here never fails the save.
  const removeMemoryCopy = async (subjectId: string): Promise<void> => {
    try {
      await deleteLearnedProfileCopy({
        client: deps.resolveMemoryClient({ tenantId: TENANT_ID }),
        userRef: subjectId,
        timeoutMs: configuration.MEMORY_RETAIN_TIMEOUT_MS,
        logger: deps.logger,
      });
    } catch (error) {
      deps.logger.warn('Learned profile copy could not be removed from memory', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const getProfileHandler: RouteHandler<typeof getPersonalizationProfileRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const profile = await deps.personalizationStore.getProfile({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
    });
    return c.json({ data: profile === undefined ? null : toWireProfile(profile) }, 200);
  };

  const updateProfileHandler: RouteHandler<typeof updatePersonalizationProfileRoute> = async c => {
    const body: UpdatePersonalizationProfileRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    let profile: PersonalizationProfile;
    try {
      profile = await deps.personalizationStore.upsertProfile({
        tenant_id: TENANT_ID,
        created_by: requestContext.subject.id,
        updated_by: requestContext.subject.id,
        ...body.profile,
        // The wire keeps the switch optional so validation can tell an explicit "off" from a
        // client that predates the toggle. A stored profile carries a concrete value either way,
        // and a client that never sends the key never opts in.
        learning_enabled: body.profile.learning_enabled ?? false,
        ...(body.expected_revision === undefined ? {} : { expected_revision: body.expected_revision }),
      });
    } catch (error) {
      if (error instanceof PersonalizationRevisionConflictError) {
        return c.json(
          {
            error: {
              message: 'Your profile changed while this page was open. Reload the page, then save again.',
              type: 'conflict',
            },
          },
          409,
        );
      }
      throw error;
    }
    await removeMemoryCopy(requestContext.subject.id);
    return c.json({ data: toWireProfile(profile) }, 200);
  };

  const deleteProfileHandler: RouteHandler<typeof deletePersonalizationProfileRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    await deps.personalizationStore.deleteProfile({ tenant_id: TENANT_ID, created_by: requestContext.subject.id });
    await removeMemoryCopy(requestContext.subject.id);
    return c.json({}, 200);
  };

  const getContextHandler: RouteHandler<typeof getPersonalizationContextRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const profile = await deps.personalizationStore.getProfile({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
    });
    return c.json({ data: profile ? buildPersonalizationContext(profile) : null }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getPersonalizationProfileRoute, getProfileHandler);
  router.openapi(updatePersonalizationProfileRoute, updateProfileHandler);
  router.openapi(deletePersonalizationProfileRoute, deleteProfileHandler);
  router.openapi(getPersonalizationContextRoute, getContextHandler);
  return router;
}
