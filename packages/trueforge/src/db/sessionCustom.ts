import { SessionStoreInvariantError } from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import type { PersonaActivationSource } from '../personas/persona';

/** Server-owned session metadata. Sessions currently have no custom fields. */
export type SessionCustom = Record<string, never>;

/**
 * The persona decision captured atomically with a turn.
 *
 * The append-only persona activation table remains the user-visible audit log,
 * but it is deliberately not the source of truth for inheritance: two forked
 * turns may finish their audit writes in either order. A child inherits this
 * snapshot from its actual parent instead.
 */
export interface TurnPersonaSnapshot {
  persona_id: string;
  persona_name: string;
  model_name: string;
  source: Extract<PersonaActivationSource, 'invocation' | 'sticky'>;
}

/**
 * Private turn metadata. Optional keys keep turns created by older binaries
 * readable; new turns always write both keys.
 */
export interface TurnCustom extends Record<string, unknown> {
  persona?: TurnPersonaSnapshot | null;
  /** Latest explicit/default UI selection observed when this turn was admitted. */
  manual_persona_activation_id?: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parsePersona(value: unknown): TurnPersonaSnapshot | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (!isPlainRecord(value)) {
    throw new SessionStoreInvariantError('turn custom persona must be an object or null');
  }
  const record = value;
  const allowed = new Set(['persona_id', 'persona_name', 'model_name', 'source']);
  if (Object.keys(record).some(key => !allowed.has(key))) {
    throw new SessionStoreInvariantError('turn custom persona contains an unknown field');
  }
  if (
    !isNonEmptyString(record['persona_id']) ||
    !isNonEmptyString(record['persona_name']) ||
    !isNonEmptyString(record['model_name']) ||
    (record['source'] !== 'invocation' && record['source'] !== 'sticky')
  ) {
    throw new SessionStoreInvariantError('turn custom persona is malformed');
  }
  return {
    persona_id: record['persona_id'],
    persona_name: record['persona_name'],
    model_name: record['model_name'],
    source: record['source'],
  };
}

/** Validates persisted JSON at the database boundary. */
export function parseTurnCustom(value: unknown): TurnCustom | null {
  if (value === null) {
    return null;
  }
  if (!isPlainRecord(value)) {
    throw new SessionStoreInvariantError('turn custom must be a plain object or null');
  }
  const allowed = new Set(['persona', 'manual_persona_activation_id']);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new SessionStoreInvariantError('turn custom contains an unknown field');
  }
  const persona = parsePersona(value['persona']);
  const manualActivationId = value['manual_persona_activation_id'];
  if (manualActivationId !== undefined && manualActivationId !== null && !isNonEmptyString(manualActivationId)) {
    throw new SessionStoreInvariantError('turn custom manual_persona_activation_id must be a non-empty string or null');
  }
  return {
    ...(persona === undefined ? {} : { persona }),
    ...(manualActivationId === undefined ? {} : { manual_persona_activation_id: manualActivationId }),
  };
}
