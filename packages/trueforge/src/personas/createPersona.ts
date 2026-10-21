import { ulid } from 'ulid';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IPersonaStore } from '../db/personaStore';
import { assertPersonaModelAvailable } from '../runtime/turnPersona';
import type { Persona, PersonaContent } from './persona';

export interface CreatePersonaForOwnerInput {
  tenant_id: string;
  /** The person the persona is created for; they are the only one who can see or change it. */
  owner_id: string;
  /** Already validated by the persona content schema, which both the API and the chat tool use. */
  content: PersonaContent;
  personaStore: IPersonaStore;
  modelProviderStore: IModelProviderStore;
}

/**
 * The one place a persona is written. A persona whose model does not exist cannot answer, so it is refused
 * before the write. Name conflicts surface as PersonaNameConflictError from the store.
 */
export async function createPersonaForOwner(input: CreatePersonaForOwnerInput): Promise<Persona> {
  await assertPersonaModelAvailable({
    displayName: input.content.display_name,
    modelName: input.content.model_name,
    tenant_id: input.tenant_id,
    modelProviderStore: input.modelProviderStore,
  });
  return input.personaStore.createPersona({
    tenant_id: input.tenant_id,
    created_by: input.owner_id,
    updated_by: input.owner_id,
    id: ulid().toLowerCase(),
    ...input.content,
  });
}
