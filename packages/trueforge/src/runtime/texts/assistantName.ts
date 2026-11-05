import type { IPersonalizationStore } from '../../db/personalizationStore';

/** Used only when the person has not named their assistant. The name itself always comes from their settings. */
export const FALLBACK_ASSISTANT_NAME = 'Your assistant';

/** The name the person gave their assistant, for the first words of a text. */
export async function assistantNameFor({
  personalization,
  owner,
}: {
  personalization: Pick<IPersonalizationStore, 'getProfile'>;
  owner: { tenant_id: string; created_by: string };
}): Promise<string> {
  const profile = await personalization.getProfile(owner);
  const name = profile?.assistant_name?.trim();
  return name === undefined || name === '' ? FALLBACK_ASSISTANT_NAME : name;
}
