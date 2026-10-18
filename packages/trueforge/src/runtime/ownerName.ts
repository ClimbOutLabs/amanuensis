import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { OIDCConfig } from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { PersonalizationProfileContent } from '../personalization/profile';

/** Global-settings key whose presence means the installer's name for the owner was already offered once. */
export const OWNER_NAME_SEEDED_KEY = 'owner_name_seeded';

type OwnerNameOutcome = 'already_seeded' | 'seeded' | 'kept_existing';

const EMPTY_PROFILE_CONTENT: PersonalizationProfileContent = {
  assistant_name: null,
  assistant_identity: null,
  voice_guidance: null,
  user_name: null,
  address_as: null,
  user_profile: null,
  pinned_preferences: [],
  learned_profile: null,
  learning_enabled: false,
};

function isBlank(value: string | null): boolean {
  return (value ?? '').trim() === '';
}

/**
 * Fills the owner's Personalization name and form of address from the installer, once per instance. Only empty
 * fields are filled, so a name the person typed is never replaced, and the marker keeps a field they clear later
 * cleared.
 */
export async function seedOwnerName({
  globalSettingsStore,
  personalizationStore,
  tenant_id,
  owner_subject_id,
  owner_name,
}: {
  globalSettingsStore: IGlobalSettingsStore;
  personalizationStore: IPersonalizationStore;
  tenant_id: string;
  owner_subject_id: string;
  owner_name: string;
}): Promise<OwnerNameOutcome> {
  if ((await globalSettingsStore.getSetting({ key: OWNER_NAME_SEEDED_KEY })) !== undefined) {
    return 'already_seeded';
  }
  const key = { tenant_id, created_by: owner_subject_id };
  const existing = await personalizationStore.getProfile(key);
  const content: PersonalizationProfileContent =
    existing === undefined
      ? EMPTY_PROFILE_CONTENT
      : {
          assistant_name: existing.assistant_name,
          assistant_identity: existing.assistant_identity,
          voice_guidance: existing.voice_guidance,
          user_name: existing.user_name,
          address_as: existing.address_as,
          user_profile: existing.user_profile,
          pinned_preferences: existing.pinned_preferences,
          learned_profile: existing.learned_profile,
          learning_enabled: existing.learning_enabled,
        };
  const fillUserName = isBlank(content.user_name);
  const fillAddressAs = isBlank(content.address_as);
  if (fillUserName || fillAddressAs) {
    await personalizationStore.upsertProfile({
      ...key,
      ...content,
      user_name: fillUserName ? owner_name : content.user_name,
      address_as: fillAddressAs ? owner_name : content.address_as,
      updated_by: owner_subject_id,
      expected_revision: existing?.revision ?? null,
    });
  }
  await globalSettingsStore.setSetting({ key: OWNER_NAME_SEEDED_KEY, value: new Date().toISOString() });
  return fillUserName || fillAddressAs ? 'seeded' : 'kept_existing';
}

/**
 * Boot step for an installed instance: the owner is the one allowed email, which is also the identity key when the
 * reference claim is the email. Anything else seeds nothing, and a failure never keeps the server from starting.
 */
export async function seedOwnerNameAtBoot({
  owner_name,
  oidc,
  logger,
  ...stores
}: {
  owner_name: string;
  oidc: Pick<OIDCConfig, 'OIDC_USER_REFERENCE_CLAIM' | 'OIDC_ALLOWED_EMAILS'> | undefined;
  logger: Logger;
  globalSettingsStore: IGlobalSettingsStore;
  personalizationStore: IPersonalizationStore;
  tenant_id: string;
}): Promise<void> {
  const owner = oidc?.OIDC_USER_REFERENCE_CLAIM === 'email' ? oidc.OIDC_ALLOWED_EMAILS : [];
  const ownerSubjectId = owner.length === 1 ? owner[0] : undefined;
  if (owner_name === '' || ownerSubjectId === undefined || ownerSubjectId.includes('*')) {
    return;
  }
  try {
    await seedOwnerName({ ...stores, owner_subject_id: ownerSubjectId, owner_name });
  } catch (error) {
    logger.warn('The name from the installer could not be added to Personalization', extractErrorLogFields(error));
  }
}
