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

/** Words that may sit between a switch lead-in and the persona name: "switch to my Zara". */
export const PERSONA_INVOCATION_DETERMINERS: ReadonlySet<string> = new Set(['my', 'the', 'a', 'an']);

/** Shared with the clause validator so the grammar and validation agree on which words are skipped. */
export function isPersonaDeterminer(word: string): boolean {
  return PERSONA_INVOCATION_DETERMINERS.has(word);
}

export interface PersonaContentNameConflict {
  /** -1 when the display name itself is the problem rather than an alias. */
  aliasIndex: number;
  alias: string;
  conflictsWith: 'display name' | 'alias' | 'invocation determiner';
  existingName: string;
}

/**
 * Finds a duplicate within one persona after the same normalization used for
 * invocation, and rejects names that are bare invocation determiners ("my",
 * "the") — a persona literally named "my" would shadow the determiner skip
 * in the invocation grammar and could never be addressed without ambiguity.
 */
export function findPersonaContentNameConflict(content: PersonaContent): PersonaContentNameConflict | undefined {
  const displayName = content.display_name.trim().replace(/\s+/g, ' ');
  const displayKey = personaMatchKey(displayName);
  if (isPersonaDeterminer(displayKey)) {
    return {
      aliasIndex: -1,
      alias: displayName,
      conflictsWith: 'invocation determiner',
      existingName: displayName,
    };
  }
  const seen = new Map<string, { kind: 'display name' | 'alias'; name: string }>();
  seen.set(displayKey, { kind: 'display name', name: displayName });
  for (const [aliasIndex, alias] of content.aliases.entries()) {
    const trimmed = alias.trim().replace(/\s+/g, ' ');
    const key = personaMatchKey(trimmed);
    if (key.length === 0) {
      continue;
    }
    if (isPersonaDeterminer(key)) {
      return { aliasIndex, alias: trimmed, conflictsWith: 'invocation determiner', existingName: trimmed };
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
    const target = conflict.aliasIndex < 0 ? 'Display name' : 'Alias';
    const reason =
      conflict.conflictsWith === 'invocation determiner'
        ? 'is a reserved persona-invocation determiner and cannot be used as a persona name'
        : `duplicates the ${conflict.conflictsWith} "${conflict.existingName}" after trimming and case-folding`;
    super(`${target} "${conflict.alias}" ${reason}.`);
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
 *
 * The switch family ("switch to", "switch back to") is what a user types when
 * they mean to change the speaker; "speak with" joins the existing
 * "speak to"/"talk to" family. Deliberately absent: "move to"/"change to"
 * (ordinary prose collides — "move to Texas next month" with a configured
 * persona "Texas" would switch the speaker) and "go back to" (same vector).
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
  'switch to ',
  'switch back to ',
  'speak with ',
];

/** One leading politeness prefix is dropped before lead-in matching, so "please switch to Zara" still switches. */
const POLITENESS_PREFIXES = [
  'could you please ',
  'can you please ',
  'would you please ',
  'please ',
  'can you ',
  'could you ',
  'would you ',
];

function stripPolitenessPrefix(probe: string): string {
  for (const prefix of POLITENESS_PREFIXES) {
    if (probe.startsWith(prefix)) {
      return probe.slice(prefix.length);
    }
  }
  return probe;
}

/**
 * The probe is normalized (single spaces, case-folded), so the token at
 * `index` ends at the next space. Returns the offset just past one optional
 * invocation determiner ("my"/"the"/"a"/"an"), or undefined when the token is
 * not a determiner.
 */
function skipOneInvocationDeterminer(probe: string, index: number): number | undefined {
  const rest = probe.slice(index);
  const space = rest.indexOf(' ');
  if (space < 0) {
    return undefined;
  }
  return isPersonaDeterminer(rest.slice(0, space)) ? index + space + 1 : undefined;
}

function matchesInvocation(probe: string, key: string, options?: { leadInOnly?: boolean | undefined }): boolean {
  const unprefixed = stripPolitenessPrefix(probe);
  // Direct address: the name, then the punctuation that marks it as address.
  // Skipped for leadInOnly matching: addressing the default assistant by name
  // ("Aman, I have a friend named Inez.") is ordinary conversation, not a
  // request to switch speakers.
  if (!options?.leadInOnly && unprefixed.startsWith(key)) {
    const next = unprefixed.charAt(key.length);
    if (next === ',' || next === ':') {
      return true;
    }
  }
  for (const leadIn of INVOCATION_LEAD_INS) {
    if (!unprefixed.startsWith(leadIn)) {
      continue;
    }
    // One optional determiner may sit between the lead-in and the name, so
    // "switch to my Zara" matches exactly like "switch to Zara".
    const nameStarts = [leadIn.length, skipOneInvocationDeterminer(unprefixed, leadIn.length)];
    for (const nameStart of nameStarts) {
      if (nameStart === undefined) {
        continue;
      }
      if (unprefixed.startsWith(key, nameStart) && endsInvocation(unprefixed, nameStart + key.length)) {
        return true;
      }
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
 *   `switch to Zara …`, `switch back to Zara …`, `speak with Zara …` — a speaker change
 *
 * One leading politeness prefix ("please ", "can you ", "could you ", "would
 * you ") and one invocation determiner ("my"/"the"/"a"/"an") may precede the
 * name: "please switch to my Zara" invokes Zara.
 *
 * A bare name with no punctuation and no lead-in ("Zara is a clothing brand")
 * is prose, not an invocation, and neither is any mention that is not at the
 * start. The longest configured name wins, which only matters when one name is
 * a prefix of another; names are unique, so the outcome never depends on the
 * order personas happen to be stored in.
 *
 * With `leadInOnly`, the direct-address form is skipped: the default
 * assistant's name shows up in ordinary conversation ("Aman, I have a
 * friend named Inez."), so only an explicit lead-in counts as a switch.
 */
export function matchPersonaInvocation<T extends PersonaContent>(input: {
  text: string;
  personas: T[];
  /**
   * Match only the lead-in forms ("switch to X"), never bare direct address
   * ("X, ..."). Used for the default assistant, whose name appears in
   * ordinary conversation.
   */
  leadInOnly?: boolean | undefined;
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
      if (matchesInvocation(probe, key, { leadInOnly: input.leadInOnly })) {
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
 *
 * The frame is identity-first and positive: it opens by naming the persona as
 * the speaker, so even a thin role definition yields an unambiguous identity.
 * The configured name is never interpolated into frame prose — it appears only
 * inside the `<persona-name>` tag, so a hostile name cannot break the frame's
 * first sentence into an instruction. Precedence over deployment identity is
 * enforced structurally at prompt assembly, not by wording here.
 */
// ASCII control characters other than tab (0x09) and newline (0x0A), stripped
// from persona instructions at render time: the same pass learned profiles get
// in personalization/profile.ts, so terminal control sequences and other
// control characters cannot reach the prompt.
// eslint-disable-next-line no-control-regex -- deliberately matching control characters to strip them.
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function buildPersonaContext(persona: Persona): PersonaContext {
  const display_name = persona.display_name.replace(CONTROL_CHAR_PATTERN, '');
  const instructions = persona.instructions.replace(CONTROL_CHAR_PATTERN, '');
  const injected_context = [
    'You are the configured persona named in <persona-name>. You are the only active assistant identity for this turn. It changes who is answering — not your tools, your approval rules, or your safety policy.',
    "Earlier assistant messages may have been written by other configured speakers. Use them for conversational continuity and factual context only. Do not imitate their identity, voice, formatting, metaphors, or behavioral style. Follow the current persona's role instead.",
    `<persona-name>${display_name}</persona-name>`,
    `<persona-role>${instructions}</persona-role>`,
  ].join('\n\n');
  if (injected_context.length > PERSONA_MAX_CONTEXT_CHARACTERS) {
    throw new Error('Persona context exceeds its bounded prompt budget');
  }
  return {
    version: PERSONA_CONTEXT_VERSION,
    persona_id: persona.id,
    persona_name: display_name,
    model_name: persona.model_name,
    injected_context,
  };
}
