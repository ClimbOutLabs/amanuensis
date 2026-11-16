// The people a persona case needs: the person's name on the Personalization page, and personas that each keep
// their own vault. All of it is put back or removed after each model, so the next model starts the same.
import { isRunStopping } from '../eval-tokens/run.mjs';

/** The vault name a case uses for memory that every persona can read. */
export const SHARED_VAULT = 'shared';

/** The fields the Personalization page saves. Saving replaces the whole page, so every field is sent. */
const PROFILE_FIELDS = Object.freeze({
  assistant_name: null,
  assistant_identity: null,
  voice_guidance: null,
  user_name: null,
  address_as: null,
  user_profile: null,
  pinned_preferences: [],
  help_areas: [],
  learned_profile: null,
});

/** The page as it can be saved again: only the fields a save takes, with the switch when it was set. */
export function savableProfile(profile) {
  const fields = Object.fromEntries(
    Object.entries(PROFILE_FIELDS).map(([key, empty]) => [key, profile?.[key] ?? empty]),
  );
  return typeof profile?.learning_enabled === 'boolean'
    ? { ...fields, learning_enabled: profile.learning_enabled }
    : fields;
}

/** `shared` is the memory every persona reads; any other name is that persona's own vault. */
export function vaultNamespace(vault) {
  return vault === SHARED_VAULT ? undefined : `persona:${vault}`;
}

/** What `setUpPersonas` changed, filled in as it goes so a set-up that stops halfway is still put back. */
export function newPersonaSetUp() {
  return { profileBefore: undefined, personaIds: {}, vaultIdsBefore: {} };
}

/**
 * Fills in the person's name and makes the set's personas, each answering with the model under test and holding
 * its own facts. Records each change in `setUp` for `tearDownPersonas`.
 * @param {{ client: any, profile: Record<string, string> | undefined, personas: { name: string, instructions: string, memories: { text: string, timestamp: string }[] }[], model: string, setUp: ReturnType<typeof newPersonaSetUp> }} options
 */
export async function setUpPersonas({ client, profile, personas, model, setUp }) {
  if (profile !== undefined) {
    setUp.profileBefore = await client.getProfile();
    await client.putProfile({ ...savableProfile(setUp.profileBefore), ...profile });
  }
  for (const persona of personas) {
    const namespace = vaultNamespace(persona.name);
    // A deleted persona leaves its vault behind, so anything already in it is noted and left alone.
    setUp.vaultIdsBefore[persona.name] = new Set(
      (await client.listMemoryEntries({ namespace })).map(entry => entry.id),
    );
    const made = await client.createPersona({
      display_name: persona.name,
      instructions: persona.instructions,
      model_name: model,
    });
    setUp.personaIds[persona.name] = made.id;
    if (persona.memories.length > 0) {
      await client.importMemories(persona.memories, { namespace });
    }
  }
}

/**
 * Removes what the personas' chats saved, then the personas, then puts the Personalization page back.
 * Returns what could not be removed.
 * @param {{ client: any, setUp: ReturnType<typeof newPersonaSetUp> }} options
 */
export async function tearDownPersonas({ client, setUp }) {
  const problems = [];
  const attempt = async (label, action) => {
    try {
      await action();
    } catch (error) {
      if (isRunStopping(error)) {
        throw error;
      }
      problems.push(label);
    }
  };
  for (const [name, before] of Object.entries(setUp.vaultIdsBefore)) {
    await attempt(`the ${name} vault`, async () => {
      for (const entry of await client.listMemoryEntries({ namespace: vaultNamespace(name) })) {
        if (!before.has(entry.id)) {
          await attempt(entry.id, () => client.deleteMemoryEntry(entry.id));
        }
      }
    });
  }
  for (const [name, id] of Object.entries(setUp.personaIds)) {
    await attempt(`the ${name} persona`, () => client.deletePersona(id));
  }
  if (setUp.profileBefore !== undefined) {
    await attempt('the Personalization page', () =>
      setUp.profileBefore === null ? client.deleteProfile() : client.putProfile(savableProfile(setUp.profileBefore)),
    );
  }
  return problems;
}
