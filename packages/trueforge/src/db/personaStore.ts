import type { Persona, PersonaActivation, PersonaActivationSource, PersonaContent } from '../personas/persona';

export interface ListPersonasInput {
  tenant_id: string;
  created_by: string;
}

export interface ListPersonaOwnersInput {
  tenant_id: string;
}

export interface GetPersonaInput extends ListPersonasInput {
  id: string;
}

export interface CreatePersonaInput extends GetPersonaInput, PersonaContent {
  updated_by: string;
}

export interface UpdatePersonaInput extends GetPersonaInput, PersonaContent {
  updated_by: string;
}

export type DeletePersonaInput = GetPersonaInput;

export interface GetSessionPersonaInput {
  tenant_id: string;
  session_id: string;
}

export interface GetTurnPersonaActivationInput extends GetSessionPersonaInput {
  turn_id: string;
}

export interface IsManualSessionPersonaCurrentInput extends GetSessionPersonaInput {
  expected_activation_id: string | null;
}

export interface ListSessionPersonaActivationsInput extends GetSessionPersonaInput {
  limit: number;
}

export interface RecordPersonaActivationInput extends GetSessionPersonaInput {
  id: string;
  turn_id: string | null;
  persona_id: string | null;
  persona_name: string | null;
  model_name: string | null;
  source: PersonaActivationSource;
}

export interface RecordPersonaActivationIfManualCurrentInput extends RecordPersonaActivationInput {
  expected_activation_id: string | null;
}

/**
 * Thrown when a write would give two personas the same name. Rejected rather
 * than resolved: an invocation that could mean either persona has no correct
 * answer, and picking one would be a guess.
 */
export class PersonaNameConflictError extends Error {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(`Persona name or alias already in use: ${conflicts.join(', ')}`);
    this.name = 'PersonaNameConflictError';
    this.conflicts = conflicts;
  }
}

/**
 * Persona records and the per-session decision log.
 *
 * Activations are append-only. The newest row is the session's active persona
 * and each row with a `turn_id` is that turn's provenance, so "who answered,
 * on which model, and why" is one read rather than a reconstruction.
 */
export interface IPersonaStore<TTransaction = never> {
  listPersonas(input: ListPersonasInput, transaction?: TTransaction): Promise<Persona[]>;
  /** Each person in the tenant who owns at least one persona, in a stable order. */
  listPersonaOwners(input: ListPersonaOwnersInput, transaction?: TTransaction): Promise<string[]>;
  getPersona(input: GetPersonaInput, transaction?: TTransaction): Promise<Persona | undefined>;
  /** Rejects a name or alias that already invokes another persona. */
  createPersona(input: CreatePersonaInput, transaction?: TTransaction): Promise<Persona>;
  /** Returns undefined when the persona does not exist for this owner. */
  updatePersona(input: UpdatePersonaInput, transaction?: TTransaction): Promise<Persona | undefined>;
  deletePersona(input: DeletePersonaInput, transaction?: TTransaction): Promise<void>;
  /** Newest activation for the session, or undefined when the chat never left the default assistant. */
  getSessionPersona(input: GetSessionPersonaInput, transaction?: TTransaction): Promise<PersonaActivation | undefined>;
  /** Newest user-selected persona/default row, excluding turn provenance. */
  getLatestManualSessionPersona(
    input: GetSessionPersonaInput,
    transaction?: TTransaction,
  ): Promise<PersonaActivation | undefined>;
  /** The activation recorded for one exact turn, never another branch's newest row. */
  getTurnPersonaActivation(
    input: GetTurnPersonaActivationInput,
    transaction?: TTransaction,
  ): Promise<PersonaActivation | undefined>;
  /** Latest manual selection committed after the named turn's activation. */
  getLatestManualSessionPersonaAfterTurn(
    input: GetTurnPersonaActivationInput,
    transaction?: TTransaction,
  ): Promise<PersonaActivation | undefined>;
  /**
   * Serializes with turn admission and manual activation writes on the session
   * row, then confirms the manual selection that was observed for the turn.
   */
  isManualSessionPersonaCurrent(
    input: IsManualSessionPersonaCurrentInput,
    transaction?: TTransaction,
  ): Promise<boolean>;
  /** Atomically records turn provenance only if the observed manual selection is still current. */
  recordPersonaActivationIfManualCurrent(
    input: RecordPersonaActivationIfManualCurrentInput,
    transaction?: TTransaction,
  ): Promise<PersonaActivation | undefined>;
  listSessionPersonaActivations(
    input: ListSessionPersonaActivationsInput,
    transaction?: TTransaction,
  ): Promise<PersonaActivation[]>;
  recordPersonaActivation(input: RecordPersonaActivationInput, transaction?: TTransaction): Promise<PersonaActivation>;
}
