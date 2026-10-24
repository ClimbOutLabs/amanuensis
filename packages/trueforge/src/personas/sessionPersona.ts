import { ulid } from 'ulid';
import type { IPersonaStore } from '../db/personaStore';
import type { Persona, PersonaActivation } from './persona';

/**
 * The one place a chat's persona is switched by hand. `persona: undefined` switches back to the default
 * assistant. Both the per-chat API and the chat's own persona tools write through here.
 */
export async function activateSessionPersona(input: {
  store: IPersonaStore;
  tenant_id: string;
  session_id: string;
  persona: Persona | undefined;
}): Promise<PersonaActivation> {
  return input.store.recordPersonaActivation({
    tenant_id: input.tenant_id,
    id: ulid().toLowerCase(),
    session_id: input.session_id,
    turn_id: null,
    persona_id: input.persona?.id ?? null,
    persona_name: input.persona?.display_name ?? null,
    model_name: input.persona?.model_name ?? null,
    source: input.persona === undefined ? 'default' : 'explicit',
  });
}
