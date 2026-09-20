/**
 * Persona domain: identity, instructions, and the model binding a user chose
 * for it. Everything model-facing about a persona is derived here, so the
 * stores, the HTTP layer, and the turn resolver share one definition.
 *
 * A persona is not a router. Nothing in this module inspects a message for
 * topic, domain, or intent — it matches configured names at an explicit
 * invocation boundary and nothing else.
 */

export const PERSONA_CONTEXT_VERSION = 'persona-context/v1';
const PERSONA_MAX_CONTEXT_CHARACTERS = 4_000;

/**
 * How the persona for a turn was decided. Recorded so a turn can say why.
 *
 * `invocation` — the user explicitly invoked the persona in the message.
 * `sticky` — carried forward from the chat's last activation.
 * `explicit` — chosen through the UI rather than by typing a name.
 * `default` — returned to the default assistant.
 */
export const PERSONA_ACTIVATION_SOURCES = ['invocation', 'sticky', 'explicit', 'default'] as const;

export type PersonaActivationSource = (typeof PERSONA_ACTIVATION_SOURCES)[number];

/** Narrows a stored source string; an unknown value means the row was written by something else. */
export function parsePersonaActivationSource(value: string): PersonaActivationSource {
  const source = PERSONA_ACTIVATION_SOURCES.find(candidate => candidate === value);
  if (source === undefined) {
    throw new Error(`Unknown persona activation source: ${value}`);
  }
  return source;
}

export interface PersonaContent {
  display_name: string;
  /** Additional names that invoke this persona. Unique across all personas. */
  aliases: string[];
  instructions: string;
  /** Fully qualified `provider/model`, resolved through the existing model contract. */
  model_name: string;
}

export interface Persona extends PersonaContent {
  tenant_id: string;
  id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

/** One recorded persona selection. `turn_id` is null for a change made outside a turn. */
export interface PersonaActivation {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string | null;
  /** Null means the default assistant was selected. */
  persona_id: string | null;
  /** Name and model selected for the turn, retained across later persona edits. */
  persona_name: string | null;
  model_name: string | null;
  source: PersonaActivationSource;
  created_at: string;
}

/** The exact persona text a root thread receives, and the identity it came from. */
export interface PersonaContext {
  version: typeof PERSONA_CONTEXT_VERSION;
  persona_id: string;
  persona_name: string;
  model_name: string;
  injected_context: string;
}

/**
 * Canonical form used for matching and collision checks: compatibility-
 * normalised, whitespace-collapsed and case-folded, so "Zara  Quinn",
 * "zara quinn" and a full-width "Ｚara Quinn" are one name.
 *
 * Case folding is locale-independent on purpose. `toLocaleLowerCase` reads the
 * host's default locale, where a Turkish one folds "I" to a dotless "ı" — so a
 * configured "Iris" would answer on one machine and not on another, for a
 * reason nothing in the UI could show. NFKC runs again after folding because
 * folding can leave a decomposed sequence behind.
 */
export function personaMatchKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFKC');
}

export interface PersonaContentNameConflict {
  aliasIndex: number;
  alias: string;
  conflictsWith: 'display name' | 'alias';
  existingName: string;
}

/** Finds a duplicate within one persona after the same normalization used for invocation. */
export function findPersonaContentNameConflict(content: PersonaContent): PersonaContentNameConflict | undefined {
  const displayName = content.display_name.trim().replace(/\s+/g, ' ');
  const seen = new Map<string, { kind: 'display name' | 'alias'; name: string }>();
  seen.set(personaMatchKey(displayName), { kind: 'display name', name: displayName });
  for (const [aliasIndex, alias] of content.aliases.entries()) {
    const trimmed = alias.trim().replace(/\s+/g, ' ');
    const key = personaMatchKey(trimmed);
    if (key.length === 0) {
      continue;
    }
    const existing = seen.get(key);
    if (existing !== undefined) {
      return { aliasIndex, alias: trimmed, conflictsWith: existing.kind, existingName: existing.name };
    }
    seen.set(key, { kind: 'alias', name: trimmed });
  }
  return undefined;
}

export class PersonaContentNameConflictError extends Error {
  readonly conflict: PersonaContentNameConflict;

  constructor(conflict: PersonaContentNameConflict) {
    super(
      `Alias "${conflict.alias}" duplicates the ${conflict.conflictsWith} "${conflict.existingName}" after trimming and case-folding.`,
    );
    this.name = 'PersonaContentNameConflictError';
    this.conflict = conflict;
  }
}

/** Every name that invokes a persona: its display name plus its aliases. */
export function personaNameKeys(content: PersonaContent): string[] {
  return [content.display_name, ...content.aliases].map(personaMatchKey).filter(key => key.length > 0);
}

export function normalizePersonaContent(content: PersonaContent): PersonaContent {
  const displayName = content.display_name.trim().replace(/\s+/g, ' ');
  const conflict = findPersonaContentNameConflict(content);
  if (conflict !== undefined) {
    throw new PersonaContentNameConflictError(conflict);
  }
  const aliases = content.aliases.map(alias => alias.trim().replace(/\s+/g, ' '));
  return {
    display_name: displayName,
    aliases,
    instructions: content.instructions.trim(),
    model_name: content.model_name.trim(),
  };
}

/** Characters that may end an invocation. Anything else means the name ran into a longer word. */
const INVOCATION_BOUNDARY = new Set([' ', ',', '.', ':', ';', '!', '?', '-', '—', '…', "'", '"']);

function endsInvocation(probe: string, index: number): boolean {
  return index >= probe.length || INVOCATION_BOUNDARY.has(probe.charAt(index));
}

/**
 * Lead-ins that turn a name into a request to speak to that persona. Matched
 * only at the very start of the message, so "I should ask Zara about it" stays
 * ordinary prose and switches nothing.
 */
const INVOCATION_LEAD_INS = [
  'let me talk to ',
  'let me speak to ',
  "i'd like to talk to ",
  "i'd like to speak to ",
  'i want to talk to ',
  'i want to speak to ',
  'i would like to talk to ',
  'i would like to speak to ',
  'can i talk to ',
  'can i speak to ',
  'talk to ',
  'speak to ',
  'ask ',
  '@',
];

function matchesInvocation(probe: string, key: string): boolean {
  // Direct address: the name, then the punctuation that marks it as address.
  if (probe.startsWith(key)) {
    const next = probe.charAt(key.length);
    if (next === ',' || next === ':') {
      return true;
    }
  }
  for (const leadIn of INVOCATION_LEAD_INS) {
    if (!probe.startsWith(leadIn) || !probe.startsWith(key, leadIn.length)) {
      continue;
    }
    if (endsInvocation(probe, leadIn.length + key.length)) {
      return true;
    }
  }
  return false;
}

/**
 * Decides whether `text` explicitly invokes one of `personas`, using only the
 * names the user configured.
 *
 * Two forms are accepted, both anchored at the first character of the message:
 *
 *   `Zara, …` / `Zara: …`  — direct address, which the punctuation marks
 *   `ask Zara …`, `let me talk to Zara`, `@Zara …` — an explicit lead-in
 *
 * A bare name with no punctuation and no lead-in ("Zara is a clothing brand")
 * is prose, not an invocation, and neither is any mention that is not at the
 * start. The longest configured name wins, which only matters when one name is
 * a prefix of another; names are unique, so the outcome never depends on the
 * order personas happen to be stored in.
 */
export function matchPersonaInvocation<T extends PersonaContent>(input: {
  text: string;
  personas: T[];
}): { persona: T; matched: string } | undefined {
  const probe = personaMatchKey(input.text);
  if (probe.length === 0) {
    return undefined;
  }
  let best: { persona: T; matched: string } | undefined;
  for (const persona of input.personas) {
    for (const key of personaNameKeys(persona)) {
      if (best !== undefined && key.length <= best.matched.length) {
        continue;
      }
      if (matchesInvocation(probe, key)) {
        best = { persona, matched: key };
      }
    }
  }
  return best;
}

/**
 * The single canonical model-facing representation of a persona, returned
 * unchanged by the API so a user can read exactly what the root thread was
 * given. It is added as one more instruction section, never as a replacement
 * for the harness prompt: tool policy and approval rules sit above it and stay
 * out of a persona's reach.
 */
export function buildPersonaContext(persona: Persona): PersonaContext {
  const injected_context = [
    'The user explicitly asked to speak with this configured persona. This persona is the only active assistant identity for this turn. It changes who is answering — not your tools, your approval rules, or your safety policy.',
    "Earlier assistant messages may have been written by other configured speakers. Use them for conversational continuity and factual context only. Do not imitate their identity, voice, formatting, metaphors, or behavioral style. Follow the current persona's role instead.",
    `<persona-name>${persona.display_name}</persona-name>`,
    `<persona-role>${persona.instructions}</persona-role>`,
  ].join('\n\n');
  if (injected_context.length > PERSONA_MAX_CONTEXT_CHARACTERS) {
    throw new Error('Persona context exceeds its bounded prompt budget');
  }
  return {
    version: PERSONA_CONTEXT_VERSION,
    persona_id: persona.id,
    persona_name: persona.display_name,
    model_name: persona.model_name,
    injected_context,
  };
}
