import type { PersonalizationProfile, PersonalizationProfileContent } from '../personalization/profile';

export interface GetPersonalizationProfileInput {
  tenant_id: string;
  created_by: string;
}

export interface UpsertPersonalizationProfileInput
  extends GetPersonalizationProfileInput, PersonalizationProfileContent {
  updated_by: string;
  /**
   * Optimistic-concurrency fence for host-side writers (the learning pass). Omitted: the write
   * is unconditional, which is the profile PUT path. A number: the write applies only while the
   * stored row is still at exactly that revision. `null`: the write applies only while no row
   * exists yet. A failed fence throws {@link PersonalizationRevisionConflictError} without
   * writing anything.
   */
  expected_revision?: number | null;
}

export type DeletePersonalizationProfileInput = GetPersonalizationProfileInput;

/** The `expected_revision` fence on {@link IPersonalizationStore.upsertProfile} did not match. */
export class PersonalizationRevisionConflictError extends Error {
  constructor(params: { created_by: string; expected_revision: number | null }) {
    super(
      params.expected_revision === null
        ? `Personalization profile for ${params.created_by} already exists; expected none`
        : `Personalization profile for ${params.created_by} is no longer at revision ${String(params.expected_revision)}`,
    );
    this.name = 'PersonalizationRevisionConflictError';
  }
}

/** Per-user profile storage. It deliberately has no session or agent association. */
export interface IPersonalizationStore<TTransaction = never> {
  getProfile(
    input: GetPersonalizationProfileInput,
    transaction?: TTransaction,
  ): Promise<PersonalizationProfile | undefined>;
  upsertProfile(input: UpsertPersonalizationProfileInput, transaction?: TTransaction): Promise<PersonalizationProfile>;
  deleteProfile(input: DeletePersonalizationProfileInput, transaction?: TTransaction): Promise<void>;
}
